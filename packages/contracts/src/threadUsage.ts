/**
 * Per-thread usage reporting.
 *
 * The usage page answers "what did this machine spend"; this answers "what did
 * this thread spend". Both read the provider CLIs' own transcripts, so the
 * figures agree, but a thread is scoped to the provider session it resumes
 * rather than to a calendar day.
 *
 * @module threadUsage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageCostSource, UsagePricing, UsageProviderKind, UsageTokenTotals } from "./usage.ts";

export const ThreadUsageInput = Schema.Struct({ threadId: ThreadId });
export type ThreadUsageInput = typeof ThreadUsageInput.Type;

/** One model's share of a thread, priced the same way the usage page prices a day. */
export const ThreadUsageModel = Schema.Struct({
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
});
export type ThreadUsageModel = typeof ThreadUsageModel.Type;

/**
 * `matched` is false when no transcript could be attributed to the thread yet:
 * a thread that has never run, or one whose provider keeps no transcript we
 * read. An empty summary and an unattributable one read very differently, so
 * the client must be able to tell them apart.
 *
 * `costUsd` is API-equivalent cost, not money spent. A subscription bills
 * separately, which is exactly why it is worth seeing next to the limits.
 */
export const ThreadUsageSummary = Schema.Struct({
  provider: Schema.NullOr(UsageProviderKind),
  matched: Schema.Boolean,
  models: Schema.Array(ThreadUsageModel),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  records: NonNegativeInt,
  firstRecordAt: Schema.NullOr(TrimmedNonEmptyString),
  lastRecordAt: Schema.NullOr(TrimmedNonEmptyString),
  pricing: UsagePricing,
  readAt: Schema.String,
  scanDurationMs: NonNegativeInt,
});
export type ThreadUsageSummary = typeof ThreadUsageSummary.Type;
