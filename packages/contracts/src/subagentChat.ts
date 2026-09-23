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

export const SUBAGENT_CHAT_WS_METHODS = {
  subscribeTranscript: "subagentChat.subscribeTranscript",
  stop: "subagentChat.stop",
} as const;

/** Producers clamp free text to these so a single long tool output cannot flood the socket. */
export const SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH = 20_000;
export const SUBAGENT_TRANSCRIPT_TOOL_INPUT_MAX_LENGTH = 2_000;
export const SUBAGENT_TRANSCRIPT_TOOL_RESULT_MAX_LENGTH = 3_000;
/** The first chunk carries at most this many entries, newest last. */
export const SUBAGENT_TRANSCRIPT_SNAPSHOT_MAX_ENTRIES = 600;

export const SubagentChatTarget = Schema.Struct({
  threadId: ThreadId,
  /** The subagent's task id, which for Claude is also its transcript's agent id. */
  agentId: TrimmedNonEmptyString,
});
export type SubagentChatTarget = typeof SubagentChatTarget.Type;

/** One rendered block of a subagent's conversation. */
export const SubagentTranscriptEntry = Schema.Struct({
  /** Stable across reads, so a client can merge chunks without duplicates. */
  id: Schema.String,
  kind: Schema.Literals(["prompt", "text", "thinking", "tool_use", "tool_result"]),
  at: Schema.NullOr(Schema.String),
  /** Prompt, answer, thinking or tool output; the one-line summary for a tool call. */
  text: Schema.String,
  toolName: Schema.optional(Schema.String),
  /** Pairs a tool_result with its tool_use. */
  toolUseId: Schema.optional(Schema.String),
  /** Tool input as JSON, clamped. */
  input: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
});
export type SubagentTranscriptEntry = typeof SubagentTranscriptEntry.Type;

export const SubagentTranscriptChunk = Schema.Struct({
  /** True on the first chunk of a subscription: it replaces what the client holds. */
  reset: Schema.Boolean,
  /** False while the transcript file does not exist (yet), or for providers without one. */
  found: Schema.Boolean,
  /** True when the snapshot dropped older entries to stay within its cap. */
  truncated: Schema.Boolean,
  entries: Schema.Array(SubagentTranscriptEntry),
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
