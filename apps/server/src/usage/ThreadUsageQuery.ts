/**
 * The `server.getThreadUsage` read.
 *
 * Resolves a thread to the provider sessions it has run under, then prices
 * their transcript records. Kept beside the usage scanner rather than in the
 * RPC layer so the thread lookup and the aggregation stay testable together.
 *
 * Orchestrator V2 records each native session as a provider thread's
 * `nativeThreadRef`. A thread imported from V1 (or from an agent session)
 * keeps its older session in `provider_session_runtime`, so both are read.
 *
 * @module ThreadUsageQuery
 */
import {
  UsageReadError,
  type ThreadUsageInput,
  type ThreadUsageSummary,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { UsageService } from "./UsageService.ts";
import {
  resumeSessionIds,
  usageProviderForDriver,
  type SessionUsageReport,
} from "./threadSessionUsage.ts";

const EMPTY_TOTALS = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
} as const;

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Session ids of transcripts imported into the thread.
 *
 * An imported thread never resumed anything of its own, so its history is the
 * file it was imported from.
 */
function importedSessionIds(runtimePayload: unknown): readonly string[] {
  if (runtimePayload === null || typeof runtimePayload !== "object") return [];
  const imported = (runtimePayload as Record<string, unknown>).importedTranscripts;
  if (!Array.isArray(imported)) return [];
  const ids: string[] = [];
  for (const entry of imported) {
    if (entry === null || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).providerSessionId;
    if (typeof id === "string" && id.trim().length > 0 && !ids.includes(id.trim()))
      ids.push(id.trim());
  }
  return ids;
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

function unmatched(readAt: string, pricing: ThreadUsageSummary["pricing"]): ThreadUsageSummary {
  return {
    provider: null,
    matched: false,
    models: [],
    totals: EMPTY_TOTALS,
    costUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    firstRecordAt: null,
    lastRecordAt: null,
    pricing,
    readAt,
    scanDurationMs: 0,
  };
}

const UNAVAILABLE_PRICING: ThreadUsageSummary["pricing"] = {
  status: "unavailable",
  source: "",
  fetchedAt: null,
  knownModels: 0,
};

/** Adds up the reports of a thread that switched providers along the way. */
function mergeReports(reports: readonly SessionUsageReport[]): SessionUsageReport {
  const [first, ...rest] = reports;
  if (first === undefined) throw new Error("mergeReports needs at least one report");
  return rest.reduce<SessionUsageReport>(
    (left, right) => ({
      models: [...left.models, ...right.models].toSorted(
        (a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model),
      ),
      totals: {
        uncachedInputTokens: left.totals.uncachedInputTokens + right.totals.uncachedInputTokens,
        cachedInputTokens: left.totals.cachedInputTokens + right.totals.cachedInputTokens,
        cacheCreationTokens: left.totals.cacheCreationTokens + right.totals.cacheCreationTokens,
        outputTokens: left.totals.outputTokens + right.totals.outputTokens,
        reasoningTokens: left.totals.reasoningTokens + right.totals.reasoningTokens,
      },
      costUsd: left.costUsd + right.costUsd,
      cacheSavingsUsd: left.cacheSavingsUsd + right.cacheSavingsUsd,
      records: left.records + right.records,
      firstRecordAtMs: minOrNull(left.firstRecordAtMs, right.firstRecordAtMs),
      lastRecordAtMs: maxOrNull(left.lastRecordAtMs, right.lastRecordAtMs),
      pricing: left.pricing,
      scanDurationMs: left.scanDurationMs + right.scanDurationMs,
    }),
    first,
  );
}

function minOrNull(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.min(left, right);
}

function maxOrNull(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.max(left, right);
}

const lookupFailed = (cause: unknown) =>
  new UsageReadError({
    reason: "scanFailed",
    detail: "The thread's provider session could not be read.",
    cause,
  });

export const readThreadUsage = Effect.fn("readThreadUsage")(function* (input: ThreadUsageInput) {
  const usage = yield* UsageService;
  const sql = yield* SqlClient.SqlClient;
  // Only the lookups can fail here; the scan reports its own read errors.
  const providerThreads = yield* sql<{
    driver: string | null;
    nativeId: string | null;
    active: number;
    threadCreatedAt: string | null;
  }>`
      SELECT provider_thread.driver AS "driver",
        json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') AS "nativeId",
        provider_thread.provider_thread_id = thread.active_provider_thread_id AS "active",
        thread.created_at AS "threadCreatedAt"
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
      WHERE provider_thread.thread_id = ${input.threadId}
      ORDER BY "active" DESC, provider_thread.updated_at DESC
    `.pipe(Effect.mapError(lookupFailed));
  const legacyRows = yield* sql<{
    providerName: string | null;
    resumeCursor: string | null;
    runtimePayload: string | null;
    threadCreatedAt: string | null;
  }>`
      SELECT runtime.provider_name AS "providerName",
        runtime.resume_cursor_json AS "resumeCursor",
        runtime.runtime_payload_json AS "runtimePayload",
        COALESCE(v2_thread.created_at, thread.created_at) AS "threadCreatedAt"
      FROM provider_session_runtime AS runtime
      LEFT JOIN orchestration_v2_projection_threads AS v2_thread
        ON v2_thread.thread_id = runtime.thread_id
      LEFT JOIN projection_threads AS thread ON thread.thread_id = runtime.thread_id
      WHERE runtime.thread_id = ${input.threadId}
    `.pipe(Effect.mapError(lookupFailed));

  const readAt = DateTime.formatIso(yield* DateTime.now);

  // Session ids per provider, the active provider thread's first.
  const sessionIdsByProvider = new Map<UsageProviderKind, string[]>();
  const addSession = (provider: UsageProviderKind | null, sessionId: string | null) => {
    const trimmed = sessionId?.trim() ?? "";
    if (provider === null || trimmed.length === 0) return;
    const ids = sessionIdsByProvider.get(provider) ?? [];
    if (!ids.includes(trimmed)) ids.push(trimmed);
    sessionIdsByProvider.set(provider, ids);
  };
  for (const row of providerThreads) {
    addSession(usageProviderForDriver(row.driver), row.nativeId);
  }
  let importedIds: readonly string[] = [];
  const legacy = legacyRows[0];
  if (legacy !== undefined) {
    const provider = usageProviderForDriver(legacy.providerName);
    if (provider !== null) {
      importedIds = importedSessionIds(parseJson(legacy.runtimePayload));
      for (const id of resumeSessionIds(parseJson(legacy.resumeCursor), provider)) {
        addSession(provider, id);
      }
      for (const id of importedIds) addSession(provider, id);
    }
  }
  if (sessionIdsByProvider.size === 0) return unmatched(readAt, UNAVAILABLE_PRICING);

  // A session the thread ran writes its transcript after the thread was
  // created, so that bounds the walk. `last_seen_at` does not: every shutdown
  // bumps it, which hid older threads' transcripts. An imported transcript
  // predates the thread, so it gets no bound at all.
  const threadCreatedAt = providerThreads[0]?.threadCreatedAt ?? legacy?.threadCreatedAt ?? null;
  const createdMs = threadCreatedAt === null ? Number.NaN : Date.parse(threadCreatedAt);
  const sinceMs = importedIds.length === 0 && Number.isFinite(createdMs) ? createdMs : 0;
  const reports = yield* Effect.forEach([...sessionIdsByProvider], ([provider, sessionIds]) =>
    usage.readSessionUsage({ provider, sessionIds, sinceMs }),
  );
  const report = mergeReports(reports);
  const [provider] = sessionIdsByProvider.keys();

  return {
    provider: provider ?? null,
    // Records may be absent because the transcript was cleaned up, but the
    // thread is still attributable; a zero total is the honest answer.
    matched: true,
    models: report.models,
    totals: report.totals,
    costUsd: report.costUsd,
    cacheSavingsUsd: report.cacheSavingsUsd,
    records: report.records,
    firstRecordAt: isoOrNull(report.firstRecordAtMs),
    lastRecordAt: isoOrNull(report.lastRecordAtMs),
    pricing: report.pricing,
    readAt,
    scanDurationMs: report.scanDurationMs,
  } satisfies ThreadUsageSummary;
});
