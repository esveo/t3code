/**
 * Fork: user insights. An opt-in profile of how the user writes and works
 * with agents, learned in the background from their own messages on Claude
 * Haiku and kept in `<stateDir>/user-insights/` on the server. These are the
 * shapes the server stores and clients read.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const USER_INSIGHTS_WS_METHODS = {
  read: "userInsights.read",
  act: "userInsights.act",
  suggest: "userInsights.suggest",
} as const;

/** Distilled observations needed before the profile counts as ready. */
export const USER_INSIGHTS_READY_SAMPLES = 40;
/** Confident traits needed before the profile counts as ready, `flow.followups` among them. */
export const USER_INSIGHTS_READY_TRAITS = 4;
/** Confidence a trait needs to count towards readiness. */
export const USER_INSIGHTS_READY_CONFIDENCE = 0.7;
/** Daily ceiling of Haiku spend, in equivalent API cost as reported by the Claude CLI. */
export const USER_INSIGHTS_DAILY_COST_CAP_USD = 1;
/** Longest trait value Haiku or the user may store. */
export const USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH = 160;

/** The fixed taxonomy. Haiku may only use these ids, one value per id. */
export const USER_INSIGHTS_TRAIT_IDS = [
  "style.language",
  "style.length",
  "style.tone",
  "style.format",
  "work.stack",
  "work.taskMix",
  "work.granularity",
  "work.verification",
  "flow.followups",
  "prefs.agent",
  "notes.1",
  "notes.2",
  "notes.3",
  "notes.4",
  "notes.5",
] as const;

export const UserInsightsTraitId = Schema.Literals(USER_INSIGHTS_TRAIT_IDS);
export type UserInsightsTraitId = typeof UserInsightsTraitId.Type;

export const UserInsightsTrait = Schema.Struct({
  id: UserInsightsTraitId,
  value: Schema.String,
  /** Decayed count of supporting observations. */
  support: Schema.Number,
  /** Decayed count of contradicting observations. */
  contradict: Schema.Number,
  /** Derived from support and contradict by the server, never by the model. */
  confidence: Schema.Number,
  lastSeen: IsoDateTime,
  /** Set by a user edit; the model may then only support or contradict it. */
  pinned: Schema.Boolean,
  /** Up to three message ids of the evidence behind the value. */
  examples: Schema.Array(Schema.String),
});
export type UserInsightsTrait = typeof UserInsightsTrait.Type;

export const UserInsightsProfile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  updatedAt: IsoDateTime,
  /** Observed messages that went into a distill so far. */
  sampleCount: NonNegativeInt,
  traits: Schema.Array(UserInsightsTrait),
});
export type UserInsightsProfile = typeof UserInsightsProfile.Type;

export const UserInsightsPauseReason = Schema.Literals([
  "budget",
  "backoff",
  "claude-unavailable",
  "low-acceptance",
]);
export type UserInsightsPauseReason = typeof UserInsightsPauseReason.Type;

export const UserInsightsStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("off") }),
  Schema.Struct({
    state: Schema.Literal("learning"),
    samples: NonNegativeInt,
    requiredSamples: NonNegativeInt,
    /** Messages collected but not yet learned from; optional for older servers. */
    pending: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({ state: Schema.Literal("ready") }),
  Schema.Struct({ state: Schema.Literal("paused"), reason: UserInsightsPauseReason }),
]);
export type UserInsightsStatus = typeof UserInsightsStatus.Type;

export const UserInsightsUsageTotals = Schema.Struct({
  calls: NonNegativeInt,
  /** Prompt tokens, cache reads and writes included. */
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** Equivalent API cost; the calls run on the user's Claude subscription. */
  costUsd: Schema.Number,
});
export type UserInsightsUsageTotals = typeof UserInsightsUsageTotals.Type;

export const UserInsightsUsageSummary = Schema.Struct({
  today: UserInsightsUsageTotals,
  last7Days: UserInsightsUsageTotals,
  total: UserInsightsUsageTotals,
  lastDistillAt: Schema.NullOr(IsoDateTime),
  dailyCapUsd: Schema.Number,
  maxDistillsPerDay: NonNegativeInt,
  maxSuggestsPerDay: NonNegativeInt,
});
export type UserInsightsUsageSummary = typeof UserInsightsUsageSummary.Type;

/** Where an import of past messages stands; it runs in the background, batch by batch. */
export const UserInsightsImportProgress = Schema.Struct({
  state: Schema.Literals(["running", "done", "cancelled"]),
  /** Messages learned from so far. */
  done: NonNegativeInt,
  total: NonNegativeInt,
});
export type UserInsightsImportProgress = typeof UserInsightsImportProgress.Type;

/** What an import of past messages would do, shown before it starts. */
export const UserInsightsImportPreview = Schema.Struct({
  messages: NonNegativeInt,
  /** Profile updates, one model call each. */
  batches: NonNegativeInt,
  /** Equivalent API cost of all batches, estimated from earlier calls. */
  estimatedCostUsd: Schema.Number,
});
export type UserInsightsImportPreview = typeof UserInsightsImportPreview.Type;

export const UserInsightsSnapshot = Schema.Struct({
  status: UserInsightsStatus,
  traits: Schema.Array(UserInsightsTrait),
  usage: UserInsightsUsageSummary,
  /** Where the server keeps everything it learned, to open it. */
  folderPath: Schema.String,
  /** The folder exists, also while insights are off, so it can still be deleted. */
  hasStoredData: Schema.Boolean,
  /** The last import of past messages; absent when none ran or from older servers. */
  import: Schema.optionalKey(Schema.NullOr(UserInsightsImportProgress)),
});
export type UserInsightsSnapshot = typeof UserInsightsSnapshot.Type;

export class UserInsightsError extends Schema.TaggedError<UserInsightsError>()(
  "UserInsightsError",
  { message: Schema.String },
) {}

/** Most suggestions one set offers. */
export const USER_INSIGHTS_MAX_SUGGESTIONS = 3;
export const USER_INSIGHTS_SUGGESTION_LABEL_MAX = 60;
export const USER_INSIGHTS_SUGGESTION_DESCRIPTION_MAX = 140;

/** A message the user might send next; choosing it fills the composer without sending. */
export const UserInsightsSuggestion = Schema.Struct({
  label: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
});
export type UserInsightsSuggestion = typeof UserInsightsSuggestion.Type;

/**
 * Why a suggest call returned no set. The first group is environment wide
 * (clients wait a while before asking that server again); the rest concern
 * this thread or turn only.
 */
export const UserInsightsSuggestSkip = Schema.Literals([
  "off",
  "not-ready",
  "paused",
  "daily-limit",
  "muted",
  "cooldown",
  "throttled",
  "dismissed",
  "not-idle",
  "nothing-useful",
  "failed",
]);
export type UserInsightsSuggestSkip = typeof UserInsightsSuggestSkip.Type;

export const UserInsightsSuggestResult = Schema.Struct({
  /** Identifies the set in later feedback; null when there are no suggestions. */
  setId: Schema.NullOr(Schema.String),
  suggestions: Schema.Array(UserInsightsSuggestion),
  skipped: Schema.NullOr(UserInsightsSuggestSkip),
});
export type UserInsightsSuggestResult = typeof UserInsightsSuggestResult.Type;

export const UserInsightsSuggestInput = Schema.Struct({ threadId: ThreadId });
export type UserInsightsSuggestInput = typeof UserInsightsSuggestInput.Type;

export const UserInsightsAction = Schema.Union([
  /** The user put suggestion `index` of the set into the composer. */
  Schema.Struct({
    type: Schema.Literal("suggestion.fill"),
    threadId: ThreadId,
    setId: TrimmedNonEmptyString,
    index: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("suggestion.dismiss"),
    threadId: ThreadId,
    setId: TrimmedNonEmptyString,
  }),
  /** No more suggestions in this thread. */
  Schema.Struct({ type: Schema.Literal("thread.mute"), threadId: ThreadId }),
  /** Sets a trait's value and pins it against model revisions. */
  Schema.Struct({
    type: Schema.Literal("trait.edit"),
    id: UserInsightsTraitId,
    value: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("trait.delete"), id: UserInsightsTraitId }),
  Schema.Struct({ type: Schema.Literal("profile.undo") }),
  /** Forgets everything learned; keeps the usage ledger. */
  Schema.Struct({ type: Schema.Literal("data.reset") }),
  /** Removes the whole folder. */
  Schema.Struct({ type: Schema.Literal("data.deleteAll") }),
  /** Counts the past messages an import would learn from; answers with `importPreview`. */
  Schema.Struct({ type: Schema.Literal("import.preview") }),
  /** Starts learning from past messages in the background. */
  Schema.Struct({ type: Schema.Literal("import.start") }),
  Schema.Struct({ type: Schema.Literal("import.cancel") }),
]);
export type UserInsightsAction = typeof UserInsightsAction.Type;

export const UserInsightsActResult = Schema.Struct({
  importPreview: Schema.optionalKey(UserInsightsImportPreview),
});
export type UserInsightsActResult = typeof UserInsightsActResult.Type;

const UserInsightsRpcError = Schema.Union([UserInsightsError, EnvironmentAuthorizationError]);

export const WsUserInsightsReadRpc = Rpc.make(USER_INSIGHTS_WS_METHODS.read, {
  payload: Schema.Struct({}),
  success: UserInsightsSnapshot,
  error: UserInsightsRpcError,
});

export const WsUserInsightsActRpc = Rpc.make(USER_INSIGHTS_WS_METHODS.act, {
  payload: UserInsightsAction,
  success: UserInsightsActResult,
  error: UserInsightsRpcError,
});

/** Spends model usage, so it needs the operate scope. */
export const WsUserInsightsSuggestRpc = Rpc.make(USER_INSIGHTS_WS_METHODS.suggest, {
  payload: UserInsightsSuggestInput,
  success: UserInsightsSuggestResult,
  error: UserInsightsRpcError,
});
