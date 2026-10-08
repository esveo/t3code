/**
 * Fork: user insights. An opt-in profile of how the user writes and works
 * with agents, learned in the background from their own messages on Claude
 * Haiku and kept in `<stateDir>/user-insights/` on the server. These are the
 * shapes the server stores and clients read.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

/** Distilled observations needed before the profile counts as ready. */
export const USER_INSIGHTS_READY_SAMPLES = 40;
/** Confident traits needed before the profile counts as ready, `flow.followups` among them. */
export const USER_INSIGHTS_READY_TRAITS = 4;
/** Confidence a trait needs to count towards readiness. */
export const USER_INSIGHTS_READY_CONFIDENCE = 0.7;
/** Daily ceiling of Haiku spend, in equivalent API cost as reported by the Claude CLI. */
export const USER_INSIGHTS_DAILY_COST_CAP_USD = 0.5;
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
  }),
  Schema.Struct({ state: Schema.Literal("ready") }),
  Schema.Struct({ state: Schema.Literal("paused"), reason: UserInsightsPauseReason }),
]);
export type UserInsightsStatus = typeof UserInsightsStatus.Type;

export const UserInsightsUsageTotals = Schema.Struct({
  calls: NonNegativeInt,
  costUsd: Schema.Number,
});
export type UserInsightsUsageTotals = typeof UserInsightsUsageTotals.Type;

export const UserInsightsUsageSummary = Schema.Struct({
  today: UserInsightsUsageTotals,
  last7Days: UserInsightsUsageTotals,
  total: UserInsightsUsageTotals,
  lastDistillAt: Schema.NullOr(IsoDateTime),
  dailyCapUsd: Schema.Number,
});
export type UserInsightsUsageSummary = typeof UserInsightsUsageSummary.Type;

export const UserInsightsSnapshot = Schema.Struct({
  status: UserInsightsStatus,
  traits: Schema.Array(UserInsightsTrait),
  usage: UserInsightsUsageSummary,
  /** Where the server keeps everything it learned, to open it. */
  folderPath: Schema.String,
});
export type UserInsightsSnapshot = typeof UserInsightsSnapshot.Type;

export class UserInsightsError extends Schema.TaggedError<UserInsightsError>()(
  "UserInsightsError",
  { message: Schema.String },
) {}
