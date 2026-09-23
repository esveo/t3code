/**
 * Fork: the subagent chat view in the Agents panel. A client subscribes to one
 * subagent's transcript while its view is open and can stop the subagent.
 * Messages to a subagent travel as a normal turn on the parent thread, so they
 * need no RPC of their own.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationMessage, OrchestrationThreadActivity } from "./orchestration.ts";

export const SUBAGENT_CHAT_WS_METHODS = {
  subscribeTranscript: "subagentChat.subscribeTranscript",
  stop: "subagentChat.stop",
} as const;

/** Producers clamp free text to this so one long answer cannot flood the socket. */
export const SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH = 20_000;
/** The first chunk carries at most this many transcript lines, newest last. */
export const SUBAGENT_TRANSCRIPT_SNAPSHOT_MAX_LINES = 600;

export const SubagentChatTarget = Schema.Struct({
  threadId: ThreadId,
  /** The subagent's task id, which for Claude is also its transcript's agent id. */
  agentId: TrimmedNonEmptyString,
});
export type SubagentChatTarget = typeof SubagentChatTarget.Type;

/**
 * A slice of the subagent's conversation in the main chat's own shapes, so the
 * client renders it with the same timeline: the parent's prompts and messages
 * as user messages, answers and thinking as assistant and reasoning messages,
 * tool calls as tool activities.
 */
export const SubagentTranscriptChunk = Schema.Struct({
  /** True on the first chunk of a subscription: it replaces what the client holds. */
  reset: Schema.Boolean,
  /** False while the transcript file does not exist (yet). */
  found: Schema.Boolean,
  /** True when the snapshot dropped older lines to stay within its cap. */
  truncated: Schema.Boolean,
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
});
export type SubagentTranscriptChunk = typeof SubagentTranscriptChunk.Type;

export class SubagentChatError extends Schema.TaggedError<SubagentChatError>()(
  "SubagentChatError",
  {
    message: Schema.String,
  },
) {}

export const WsSubagentChatSubscribeTranscriptRpc = Rpc.make(
  SUBAGENT_CHAT_WS_METHODS.subscribeTranscript,
  {
    payload: SubagentChatTarget,
    success: SubagentTranscriptChunk,
    error: Schema.Union([SubagentChatError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubagentChatStopRpc = Rpc.make(SUBAGENT_CHAT_WS_METHODS.stop, {
  payload: SubagentChatTarget,
  success: Schema.Struct({}),
  error: Schema.Union([SubagentChatError, EnvironmentAuthorizationError]),
});
