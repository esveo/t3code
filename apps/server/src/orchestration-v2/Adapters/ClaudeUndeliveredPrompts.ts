// Fork: carries prompts an early interrupt dropped into the next turn.
//
// The Claude CLI dequeues a prompt well before it records it in the
// transcript. Stop closes the query, so a Stop in that gap (a resumed session
// still loading, hooks still running) discards the prompt: the model never
// sees it and the resumed session has no trace of it. Each user turn's
// message stays here until the CLI replies to it; a turn that ends
// interrupted or failed without a reply hands its message(s) to the next
// user turn on the same native thread.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type ClaudeUserMessageContent = SDKUserMessage["message"]["content"];
type ClaudeUserContentBlock = Exclude<ClaudeUserMessageContent, string>[number];

export const UNDELIVERED_PROMPT_PREAMBLE =
  "[The user sent the following earlier message(s), but the turn was interrupted before you received them. Take them into account.]";
const UNDELIVERED_PROMPT_CURRENT = "[Current message:]";

function contentBlocks(content: ClaudeUserMessageContent): Array<ClaudeUserContentBlock> {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function echoedPromptUuids(message: SDKMessage): ReadonlyArray<string> | undefined {
  const uuids = Reflect.get(message, "user_message_uuids");
  if (Array.isArray(uuids)) return uuids.filter((uuid) => typeof uuid === "string");
  const uuid = Reflect.get(message, "user_message_uuid");
  return typeof uuid === "string" ? [uuid] : undefined;
}

/**
 * A top-level reply frame proves the CLI consumed the prompt. Frames stamped
 * for another send (a wake turn) do not count. A result counts only when it
 * names the prompt: an interrupt ends with an unstamped result even when the
 * prompt was never read.
 */
export function isClaudePromptAcknowledgement(message: SDKMessage, promptUuid: string): boolean {
  const uuids = echoedPromptUuids(message);
  if (message.type === "result") return uuids?.includes(promptUuid) ?? false;
  if (message.type !== "stream_event" && message.type !== "assistant") return false;
  if (message.parent_tool_use_id !== null) return false;
  return uuids === undefined || uuids.includes(promptUuid);
}

interface PendingPrompt {
  readonly nativeThreadId: string;
  readonly promptUuid: string;
  /** Earlier undelivered messages first, then the turn's own message. */
  readonly contents: ReadonlyArray<ClaudeUserMessageContent>;
  acknowledged: boolean;
}

export function makeClaudeUndeliveredPrompts() {
  const pendingByTurn = new Map<string, PendingPrompt>();
  const carriedByNativeThread = new Map<string, ReadonlyArray<ClaudeUserMessageContent>>();

  return {
    /** Starts tracking a user turn's prompt; returns it with any carried messages prepended. */
    begin(input: {
      readonly nativeThreadId: string;
      readonly providerTurnId: string;
      readonly promptUuid: string;
      readonly message: SDKUserMessage;
    }): SDKUserMessage {
      const carried = carriedByNativeThread.get(input.nativeThreadId) ?? [];
      carriedByNativeThread.delete(input.nativeThreadId);
      pendingByTurn.set(input.providerTurnId, {
        nativeThreadId: input.nativeThreadId,
        promptUuid: input.promptUuid,
        contents: [...carried, input.message.message.content],
        acknowledged: false,
      });
      if (carried.length === 0) return input.message;
      return {
        ...input.message,
        message: {
          ...input.message.message,
          content: [
            { type: "text", text: UNDELIVERED_PROMPT_PREAMBLE },
            ...carried.flatMap(contentBlocks),
            { type: "text", text: UNDELIVERED_PROMPT_CURRENT },
            ...contentBlocks(input.message.message.content),
          ],
        },
      };
    },
    observe(providerTurnId: string, message: SDKMessage): void {
      const pending = pendingByTurn.get(providerTurnId);
      if (pending && !pending.acknowledged) {
        pending.acknowledged = isClaudePromptAcknowledgement(message, pending.promptUuid);
      }
    },
    settle(providerTurnId: string, status: string): void {
      const pending = pendingByTurn.get(providerTurnId);
      pendingByTurn.delete(providerTurnId);
      if (pending && !pending.acknowledged && (status === "interrupted" || status === "failed")) {
        carriedByNativeThread.set(pending.nativeThreadId, pending.contents);
      }
    },
    /** Rolled-back turns take their undelivered messages with them. */
    discard(nativeThreadId: string): void {
      carriedByNativeThread.delete(nativeThreadId);
    },
  };
}
