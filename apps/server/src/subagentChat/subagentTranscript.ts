/**
 * Fork: turns lines of a Claude subagent transcript
 * (`<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`) into the
 * messages and activities the main chat renders, so the client shows a
 * subagent with the same timeline.
 *
 * Everything that reaches the subagent from its parent (the task prompt and
 * later SendMessage deliveries) becomes a user message. Answers become
 * assistant messages, thinking becomes reasoning, and each tool call becomes a
 * tool.started activity that its result completes, as the Claude adapter does
 * for the parent. Harness attachments (reminders, listings, task
 * notifications) are dropped.
 */
import {
  EventId,
  MessageId,
  SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  classifyToolItemType,
  summarizeToolRequest,
  titleForTool,
} from "../provider/Layers/ClaudeAdapter.ts";
import { projectActivityPayload } from "../orchestration/ActivityPayloadProjection.ts";

type Json = Record<string, unknown>;

export interface SubagentTranscriptSlice {
  readonly messages: OrchestrationMessage[];
  readonly activities: OrchestrationThreadActivity[];
}

interface PendingToolCall {
  readonly toolName: string;
  readonly input: Json;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(text: string): string {
  const max = SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH;
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
    : text;
}

function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  at: string,
): OrchestrationMessage {
  return {
    id: MessageId.make(`subagent:${id}`),
    role,
    text: clamp(text),
    turnId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}

function toolActivity(input: {
  readonly id: string;
  readonly phase: "started" | "completed";
  readonly toolUseId: string;
  readonly call: PendingToolCall;
  readonly result?: Json;
  readonly at: string;
}): OrchestrationThreadActivity {
  const itemType = classifyToolItemType(input.call.toolName, input.call.input);
  const title = titleForTool(itemType);
  const failed = input.result?.is_error === true;
  return projectActivityPayload({
    id: EventId.make(`subagent:${input.id}:${input.phase}`),
    tone: "tool",
    kind: `tool.${input.phase}`,
    summary: input.phase === "started" ? `${title} started` : title,
    payload: {
      itemType,
      toolCallId: input.toolUseId,
      status: input.phase === "started" ? "inProgress" : failed ? "failed" : "completed",
      title,
      detail: summarizeToolRequest(input.call.toolName, input.call.input),
      data: {
        toolName: input.call.toolName,
        input: input.call.input,
        ...(input.result ? { result: input.result } : {}),
      },
    },
    turnId: null,
    createdAt: input.at,
  });
}

/**
 * A converter per subscription: tool results name only their call's id, so it
 * remembers the calls it has seen to complete them with the call's name and input.
 */
export function createSubagentTranscriptConverter() {
  const calls = new Map<string, PendingToolCall>();

  return function convertLine(line: string): SubagentTranscriptSlice {
    const slice: SubagentTranscriptSlice = { messages: [], activities: [] };
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return slice;
    }
    // Every conversation line carries both; the rest is harness bookkeeping.
    if (!isRecord(record) || typeof record.uuid !== "string") return slice;
    if (typeof record.timestamp !== "string") return slice;
    const uuid = record.uuid;
    const at = record.timestamp;

    if (record.type === "attachment") {
      // Messages the parent sends while the subagent works arrive queued.
      const attachment = record.attachment;
      if (!isRecord(attachment) || attachment.type !== "queued_command") return slice;
      const prompt = typeof attachment.prompt === "string" ? attachment.prompt : "";
      if (prompt.trim().length > 0 && !prompt.startsWith("<task-notification>")) {
        slice.messages.push(message(uuid, "user", prompt, at));
      }
      return slice;
    }

    const content = isRecord(record.message) ? record.message.content : undefined;

    if (record.type === "user") {
      if (typeof content === "string") {
        if (content.trim().length > 0 && !content.startsWith("<task-notification>")) {
          slice.messages.push(message(uuid, "user", content, at));
        }
        return slice;
      }
      if (!Array.isArray(content)) return slice;
      content.forEach((block, index) => {
        if (!isRecord(block)) return;
        const id = `${uuid}:${index}`;
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const call = calls.get(block.tool_use_id) ?? { toolName: "Tool", input: {} };
          calls.delete(block.tool_use_id);
          slice.activities.push(
            toolActivity({
              id,
              phase: "completed",
              toolUseId: block.tool_use_id,
              call,
              result: block,
              at,
            }),
          );
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          slice.messages.push(message(id, "user", block.text, at));
        }
      });
      return slice;
    }

    if (record.type === "assistant" && Array.isArray(content)) {
      content.forEach((block, index) => {
        if (!isRecord(block)) return;
        const id = `${uuid}:${index}`;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          slice.messages.push(message(id, "assistant", block.text, at));
        } else if (
          // Thinking without text is a signature-only block; nothing to read.
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          slice.messages.push(message(id, "reasoning", block.thinking, at));
        } else if (
          (block.type === "tool_use" ||
            block.type === "server_tool_use" ||
            block.type === "mcp_tool_use") &&
          typeof block.name === "string" &&
          typeof block.id === "string"
        ) {
          const call = { toolName: block.name, input: isRecord(block.input) ? block.input : {} };
          calls.set(block.id, call);
          slice.activities.push(
            toolActivity({ id, phase: "started", toolUseId: block.id, call, at }),
          );
        }
      });
    }
    return slice;
  };
}

/**
 * Splits a chunk read from the file into complete lines. The last element is
 * the unterminated remainder, carried into the next read: the harness can be
 * mid-write when we read.
 */
export function splitTranscriptLines(buffered: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const lastNewline = buffered.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], rest: buffered };
  return {
    lines: buffered
      .slice(0, lastNewline)
      .split("\n")
      .filter((line) => line.length > 0),
    rest: buffered.slice(lastNewline + 1),
  };
}
