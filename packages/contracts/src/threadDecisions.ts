/**
 * Fork: decisions a coordinator thread asks the user for. The coordinator
 * records each open question with its MCP tools instead of numbering it in a
 * chat message, so nothing scrolls out of sight while updates of its child
 * threads keep arriving. The Inbox tab of the right panel shows them; the user
 * answers there, and the answers reach the coordinator as one message.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_DECISIONS_WS_METHODS = {
  subscribe: "threadDecisions.subscribe",
  act: "threadDecisions.act",
} as const;

export const ThreadDecisionOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  pros: Schema.Array(Schema.String),
  cons: Schema.Array(Schema.String),
});
export type ThreadDecisionOption = typeof ThreadDecisionOption.Type;

export const ThreadDecisionUrgency = Schema.Literals(["now", "today", "later"]);
export type ThreadDecisionUrgency = typeof ThreadDecisionUrgency.Type;

/**
 * open: waits on the user. answered: the user's answer went to the
 * coordinator. resolved: settled without an answer, by the coordinator (the
 * question took care of itself) or by the user ("done because …").
 */
export const ThreadDecisionStatus = Schema.Literals(["open", "answered", "resolved"]);
export type ThreadDecisionStatus = typeof ThreadDecisionStatus.Type;

export const ThreadDecisionAnswer = Schema.Struct({
  optionId: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.NullOr(Schema.String),
});
export type ThreadDecisionAnswer = typeof ThreadDecisionAnswer.Type;

export const ThreadDecision = Schema.Struct({
  /** Chosen by the coordinator, unique within it; calling upsert again with it updates the decision. */
  id: TrimmedNonEmptyString,
  coordinatorThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  /** Markdown the user may need to decide: facts, risks, a draft. */
  context: Schema.NullOr(Schema.String),
  options: Schema.Array(ThreadDecisionOption),
  recommendedOptionId: Schema.NullOr(TrimmedNonEmptyString),
  recommendationReason: Schema.NullOr(Schema.String),
  urgency: ThreadDecisionUrgency,
  /** The child thread the question comes from, if not the coordinator itself. */
  sourceThreadId: Schema.NullOr(ThreadId),
  /** The child thread the answer is for; the coordinator passes it on. */
  routeToThreadId: Schema.NullOr(ThreadId),
  /** Ids of decisions this one depends on. */
  dependsOn: Schema.Array(TrimmedNonEmptyString),
  status: ThreadDecisionStatus,
  answer: Schema.NullOr(ThreadDecisionAnswer),
  resolvedReason: Schema.NullOr(Schema.String),
  resolvedBy: Schema.NullOr(Schema.Literals(["coordinator", "user"])),
  /** Set while the user snoozed it; the coordinator's next change to any decision clears it. */
  snoozedAt: Schema.NullOr(IsoDateTime),
  /** When the user last asked back instead of answering. */
  askedBackAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadDecision = typeof ThreadDecision.Type;

export const ThreadDecisionsTarget = Schema.Struct({ threadId: ThreadId });
export type ThreadDecisionsTarget = typeof ThreadDecisionsTarget.Type;

/** Every decision of the coordinator; each change sends the full list again, it stays small. */
export const ThreadDecisionsSnapshot = Schema.Struct({
  decisions: Schema.Array(ThreadDecision),
});
export type ThreadDecisionsSnapshot = typeof ThreadDecisionsSnapshot.Type;

/**
 * One reply in a submit. An option and/or text answers the decision;
 * askBack asks the coordinator for pros and cons instead and keeps it open;
 * dismissReason settles it without an answer.
 */
export const ThreadDecisionReply = Schema.Struct({
  decisionId: TrimmedNonEmptyString,
  optionId: Schema.optional(TrimmedNonEmptyString),
  text: Schema.optional(Schema.String),
  askBack: Schema.optional(Schema.Boolean),
  dismissReason: Schema.optional(Schema.String),
});
export type ThreadDecisionReply = typeof ThreadDecisionReply.Type;

export const ThreadDecisionsAction = Schema.Union([
  /** Sends the replies to the coordinator as one message and records them. */
  Schema.Struct({
    type: Schema.Literal("submit"),
    threadId: ThreadId,
    replies: Schema.Array(ThreadDecisionReply),
  }),
  Schema.Struct({
    type: Schema.Literals(["snooze", "unsnooze", "reopen"]),
    threadId: ThreadId,
    decisionId: TrimmedNonEmptyString,
  }),
]);
export type ThreadDecisionsAction = typeof ThreadDecisionsAction.Type;

export class ThreadDecisionsError extends Schema.TaggedError<ThreadDecisionsError>()(
  "ThreadDecisionsError",
  { message: Schema.String },
) {}

export const WsThreadDecisionsSubscribeRpc = Rpc.make(THREAD_DECISIONS_WS_METHODS.subscribe, {
  payload: ThreadDecisionsTarget,
  success: ThreadDecisionsSnapshot,
  error: Schema.Union([ThreadDecisionsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsThreadDecisionsActRpc = Rpc.make(THREAD_DECISIONS_WS_METHODS.act, {
  payload: ThreadDecisionsAction,
  success: Schema.Struct({}),
  error: Schema.Union([ThreadDecisionsError, EnvironmentAuthorizationError]),
});
