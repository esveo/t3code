/**
 * Attribution of transcript records to one thread.
 *
 * A thread's cost is whatever its provider session wrote to disk. The session
 * a thread resumes is the durable link between the two, so the resume cursor
 * is what turns a thread id into transcript records. Keeping the parsing and
 * the aggregation here leaves `UsageService` with one thin method.
 *
 * @module threadSessionUsage
 */
import type { UsagePricing, UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

import type { UsageRecord } from "./usageTranscripts.ts";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";

/** Drivers whose transcripts the usage scanner reads. The rest report nothing. */
const PROVIDER_BY_DRIVER: Readonly<Record<string, UsageProviderKind>> = {
  antigravity: "antigravity",
  claudeAgent: "claude",
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
};

export function usageProviderForDriver(driver: string | null): UsageProviderKind | null {
  return driver === null ? null : (PROVIDER_BY_DRIVER[driver] ?? null);
}

/**
 * The key each adapter stores its session under.
 *
 * Claude's cursor also carries T3's own thread id under `threadId`, so reading
 * every key would attribute another provider's transcript to the thread
 * whenever those ids happened to collide.
 */
const SESSION_KEY_BY_PROVIDER: Readonly<Record<UsageProviderKind, string>> = {
  antigravity: "sessionId",
  claude: "resume",
  codex: "threadId",
  cursor: "sessionId",
  grok: "sessionId",
  opencode: "sessionId",
};

/** The provider session a resume cursor names, or nothing when it names none. */
export function resumeSessionIds(cursor: unknown, provider: UsageProviderKind): readonly string[] {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return [];
  const value = (cursor as Record<string, unknown>)[SESSION_KEY_BY_PROVIDER[provider]];
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed.length === 0 ? [] : [trimmed];
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function addTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

export interface ThreadUsageModelSummary {
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly costSource: "providerReported" | "modelPriced" | "unpriced";
  readonly records: number;
}

export interface ThreadSessionUsage {
  readonly models: readonly ThreadUsageModelSummary[];
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly records: number;
  readonly firstRecordAtMs: number | null;
  readonly lastRecordAtMs: number | null;
}

interface ModelAccumulator {
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  records: number;
}

/**
 * Groups a session's records by model and prices each group.
 *
 * A provider-reported cost wins over the rate table for the whole model group,
 * exactly as the daily summary decides it, so the two figures cannot disagree
 * about the same tokens.
 */
export function summarizeSessionRecords(input: {
  readonly records: readonly UsageRecord[];
  readonly sessionIds: ReadonlySet<string>;
  readonly rates: RateTable;
  readonly priceOverrides: RateTable;
}): ThreadSessionUsage {
  const byModel = new Map<string, ModelAccumulator>();
  const seen = new Set<string>();
  let firstRecordAtMs: number | null = null;
  let lastRecordAtMs: number | null = null;
  let records = 0;

  for (const record of input.records) {
    if (!input.sessionIds.has(record.sessionId)) continue;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    records += 1;
    firstRecordAtMs =
      firstRecordAtMs === null ? record.timestampMs : Math.min(firstRecordAtMs, record.timestampMs);
    lastRecordAtMs =
      lastRecordAtMs === null ? record.timestampMs : Math.max(lastRecordAtMs, record.timestampMs);

    const current = byModel.get(record.model) ?? {
      totals: EMPTY_TOTALS,
      costUsd: 0,
      cacheSavingsUsd: 0,
      unpricedRecords: 0,
      providerReportedRecords: 0,
      records: 0,
    };
    const priced = priceUsage(input.rates, record, input.priceOverrides);
    byModel.set(record.model, {
      totals: addTotals(current.totals, record.totals),
      costUsd: current.costUsd + priced.costUsd,
      cacheSavingsUsd:
        current.cacheSavingsUsd + cacheSavingsUsd(input.rates, record, input.priceOverrides),
      unpricedRecords: current.unpricedRecords + (priced.costSource === "unpriced" ? 1 : 0),
      providerReportedRecords:
        current.providerReportedRecords + (priced.costSource === "providerReported" ? 1 : 0),
      records: current.records + 1,
    });
  }

  const models: ThreadUsageModelSummary[] = [];
  let totals = EMPTY_TOTALS;
  let costUsd = 0;
  let savingsUsd = 0;
  for (const [model, accumulator] of byModel) {
    const costSource =
      accumulator.unpricedRecords === accumulator.records
        ? "unpriced"
        : accumulator.providerReportedRecords === accumulator.records
          ? "providerReported"
          : "modelPriced";
    models.push({
      model,
      totals: accumulator.totals,
      costUsd: accumulator.costUsd,
      cacheSavingsUsd: accumulator.cacheSavingsUsd,
      costSource,
      records: accumulator.records,
    });
    totals = addTotals(totals, accumulator.totals);
    costUsd += accumulator.costUsd;
    savingsUsd += accumulator.cacheSavingsUsd;
  }
  models.sort(
    (left, right) => right.costUsd - left.costUsd || left.model.localeCompare(right.model),
  );

  return {
    models,
    totals,
    costUsd,
    cacheSavingsUsd: savingsUsd,
    records,
    firstRecordAtMs,
    lastRecordAtMs,
  };
}

/** What `UsageService.readSessionUsage` is asked for. */
export interface SessionUsageInput {
  readonly provider: UsageProviderKind;
  readonly sessionIds: readonly string[];
  /** Epoch ms no later than the session's last write; see `readSessionUsage`. */
  readonly sinceMs: number;
}

export interface SessionUsageReport extends ThreadSessionUsage {
  readonly pricing: UsagePricing;
  readonly scanDurationMs: number;
}

/** The report of a session that wrote nothing, for test and stub layers. */
export function emptySessionUsageReport(pricing: UsagePricing): SessionUsageReport {
  return {
    models: [],
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    firstRecordAtMs: null,
    lastRecordAtMs: null,
    pricing,
    scanDurationMs: 0,
  };
}
