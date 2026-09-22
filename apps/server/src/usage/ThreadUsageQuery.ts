/**
 * The `server.getThreadUsage` read.
 *
 * Resolves a thread to the provider sessions it has run under, then prices
 * their transcript records. Kept beside the usage scanner rather than in the
 * RPC layer so the thread lookup and the aggregation stay testable together.
 *
 * @module ThreadUsageQuery
 */
import { UsageReadError, type ThreadUsageInput, type ThreadUsageSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageService } from "./UsageService.ts";
import { resumeSessionIds, usageProviderForDriver } from "./threadSessionUsage.ts";

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

export const readThreadUsage = Effect.fn("readThreadUsage")(function* (input: ThreadUsageInput) {
  const usage = yield* UsageService;
  const sql = yield* SqlClient.SqlClient;
  // Only the lookup can fail here; the scan reports its own read errors.
  const rows = yield* sql<{
    providerName: string | null;
    resumeCursor: string | null;
    runtimePayload: string | null;
    threadCreatedAt: string | null;
  }>`
      SELECT runtime.provider_name AS "providerName",
        runtime.resume_cursor_json AS "resumeCursor",
        runtime.runtime_payload_json AS "runtimePayload",
        thread.created_at AS "threadCreatedAt"
      FROM provider_session_runtime AS runtime
      LEFT JOIN projection_threads AS thread ON thread.thread_id = runtime.thread_id
      WHERE runtime.thread_id = ${input.threadId}
    `.pipe(
    Effect.mapError(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "The thread's provider session could not be read.",
          cause,
        }),
    ),
  );

  const readAt = DateTime.formatIso(yield* DateTime.now);
  const row = rows[0];
  if (row === undefined) return unmatched(readAt, UNAVAILABLE_PRICING);

  const provider = usageProviderForDriver(row.providerName);
  if (provider === null) return unmatched(readAt, UNAVAILABLE_PRICING);

  const importedIds = importedSessionIds(parseJson(row.runtimePayload));
  const sessionIds = [...resumeSessionIds(parseJson(row.resumeCursor), provider), ...importedIds];
  if (sessionIds.length === 0) return unmatched(readAt, UNAVAILABLE_PRICING);

  // A session the thread ran writes its transcript after the thread was
  // created, so that bounds the walk. `last_seen_at` does not: every shutdown
  // bumps it, which hid older threads' transcripts. An imported transcript
  // predates the thread, so it gets no bound at all.
  const createdMs = row.threadCreatedAt === null ? Number.NaN : Date.parse(row.threadCreatedAt);
  const report = yield* usage.readSessionUsage({
    provider,
    sessionIds,
    sinceMs: importedIds.length === 0 && Number.isFinite(createdMs) ? createdMs : 0,
  });

  return {
    provider,
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
