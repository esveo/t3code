/**
 * Fork: session statistics and quota estimates of the initiatives. A refresh
 * measures each session (tokens and API-equivalent cost from the provider's
 * transcripts, turns and run time from the thread, how it ended) and records
 * the providers' quota windows; the quota is also recorded on its own every
 * quarter hour. The report shows each session's actual numbers beside the
 * range similar sessions took, and each window's use split by the delta
 * method into this initiative, the others and the unattributed rest. It only
 * shows; nothing is braked on these numbers yet.
 */
import {
  type InitiativeAuthor,
  type InitiativeQuotaObservation,
  type InitiativeQuotaShare,
  type InitiativeSession,
  type InitiativeSessionStats,
  InitiativesError,
  type InitiativeStatsReport,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import type { ThreadBridge } from "@t3tools/initiatives/bridge";
import { providerOfSessionSource, sessionStateOf } from "@t3tools/initiatives/model";
import {
  attributeQuota,
  attributionConfidence,
  estimateFrom,
  type StatsSample,
} from "@t3tools/initiatives/stats";
import type { InitiativeStore } from "@t3tools/initiatives/store";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const failure = (message: string) => new InitiativesError({ message });

export interface ThreadUsageTotals {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** A window is observed again after this long even when nothing changed. */
const OBSERVATION_REFRESH_MS = 60 * 60 * 1000;

const tokensOf = (stats: InitiativeSessionStats) =>
  stats.tokens
    ? stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite
    : null;

const sampleOf = (stats: InitiativeSessionStats): StatsSample => ({
  provider: stats.provider,
  model: stats.model,
  apiUsd: stats.apiUsd,
  tokens: tokensOf(stats),
  durationMs: stats.durationMs,
  turns: stats.turns,
});

const outcomeOf = (shell: OrchestrationThreadShell | null, nowMs: number) => {
  if (!shell) return null;
  const state = sessionStateOf(shell, nowMs);
  return state === "done" || state === "review"
    ? ("done" as const)
    : state === "stopped" || state === "failed"
      ? ("cancelled" as const)
      : null;
};

export const makeInitiativeStats = (options: {
  readonly store: InitiativeStore;
  readonly bridge: ThreadBridge;
  readonly readUsage: (threadId: ThreadId) => Effect.Effect<ThreadUsageTotals | null>;
  readonly changed: (initiativeId: string | null) => Effect.Effect<unknown>;
}) => {
  const { store, bridge } = options;
  const fromStore = (error: { readonly message: string }) => failure(error.message);
  const author = "system:stats" as const;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** Records each provider window that moved, or was not seen for an hour. */
  const recordQuota = Effect.gen(function* () {
    const providers = yield* bridge.providerUsage();
    const nowMs = yield* Clock.currentTimeMillis;
    let recorded = 0;
    for (const provider of providers) {
      const limits = provider.usageLimits;
      if (!limits) continue;
      const quality = limits.unavailable ? "unavailable" : "ok";
      for (const window of limits.windows) {
        const history = yield* store
          .list("quotaObservation", { groupKey: `${provider.instanceId}|${window.id}` })
          .pipe(Effect.mapError(fromStore));
        const last = history.at(-1);
        const unchanged =
          last &&
          last.usedPercent === window.usedPercent &&
          last.resetsAt === (window.resetsAt ?? null) &&
          nowMs - Date.parse(last.checkedAt) < OBSERVATION_REFRESH_MS;
        if (unchanged) continue;
        yield* store
          .insert(
            "quotaObservation",
            {
              provider: provider.driver,
              accountId: provider.instanceId,
              windowId: window.id,
              windowKind: window.kind,
              windowLabel: window.label,
              resetsAt: window.resetsAt ?? null,
              windowDurationMins: window.windowDurationMins ?? null,
              usedPercent: window.usedPercent,
              checkedAt: limits.checkedAt,
              quality,
            },
            author,
          )
          .pipe(Effect.mapError(fromStore));
        recorded += 1;
      }
    }
    return recorded;
  });

  const measure = (
    session: InitiativeSession,
    shell: OrchestrationThreadShell | null,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const threadId = session.threadId;
      const usage = threadId ? yield* options.readUsage(threadId) : null;
      const activity = threadId
        ? yield* bridge.threadActivity(threadId).pipe(Effect.orElseSucceed(() => null))
        : null;
      const startedAt = activity?.firstAt ?? session.startedAt;
      const endedAt = activity?.lastAt ?? session.endedAt;
      const durationMs =
        startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;
      return {
        initiativeId: session.initiativeId,
        sessionId: session.id,
        provider:
          shell?.modelSelection?.instanceId ??
          providerOfSessionSource(session.source) ??
          session.source,
        model: shell?.modelSelection?.model ?? session.model,
        taskType: null,
        roleId: null,
        tokens: usage
          ? {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            }
          : session.tokens !== null
            ? { input: session.tokens, output: 0, cacheRead: 0, cacheWrite: 0 }
            : null,
        apiUsd: usage?.costUsd ?? null,
        startedAt,
        endedAt,
        durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
        turns: activity?.turns ?? null,
        outcome: session.source === "t3" ? outcomeOf(shell, nowMs) : "done",
        measuredAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      } satisfies Omit<
        InitiativeSessionStats,
        "id" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
      >;
    });

  /** Measures every session of the initiative again and records the quota. */
  const refresh = (initiativeId: string, by: InitiativeAuthor) =>
    Effect.gen(function* () {
      const sessions = (yield* store
        .list("session", { initiativeId })
        .pipe(Effect.mapError(fromStore))).filter((session) => session.assignment !== "released");
      const shells = new Map(
        (yield* bridge.listThreads().pipe(Effect.orElseSucceed(() => []))).map((shell) => [
          shell.id,
          shell,
        ]),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        sessions,
        (session) =>
          Effect.gen(function* () {
            const stats = yield* measure(
              session,
              session.threadId ? (shells.get(session.threadId) ?? null) : null,
              nowMs,
            );
            const existing = yield* store
              .findByKey("sessionStats", session.id)
              .pipe(Effect.mapError(fromStore));
            yield* (
              Option.isSome(existing)
                ? store.update("sessionStats", existing.value.id, stats, { author: by })
                : store.insert("sessionStats", stats, by)
            ).pipe(Effect.mapError(fromStore));
          }),
        { concurrency: 4, discard: true },
      );
      yield* recordQuota.pipe(Effect.ignore);
      yield* options.changed(initiativeId);
    });

  /**
   * Every window of the given accounts now, with the initiative's estimated
   * share of its current period.
   */
  const quotaShares = (initiativeId: string | null, accounts: ReadonlySet<string> | null) =>
    Effect.gen(function* () {
      const observations = yield* store.list("quotaObservation").pipe(Effect.mapError(fromStore));
      const allStats = yield* store.list("sessionStats").pipe(Effect.mapError(fromStore));
      const windows = new Map<string, Array<InitiativeQuotaObservation>>();
      for (const observation of observations) {
        if (accounts && !accounts.has(observation.accountId)) continue;
        const key = `${observation.accountId}|${observation.windowId}`;
        const list = windows.get(key) ?? [];
        list.push(observation);
        windows.set(key, list);
      }
      const shares: Array<InitiativeQuotaShare> = [];
      for (const list of windows.values()) {
        const latest = list.toSorted((a, b) => a.checkedAt.localeCompare(b.checkedAt)).at(-1)!;
        const sessions = allStats.flatMap((stats) => {
          const tokens = tokensOf(stats);
          if (stats.provider !== latest.accountId || !stats.startedAt || tokens === null) return [];
          const startMs = Date.parse(stats.startedAt);
          const endMs = stats.endedAt ? Date.parse(stats.endedAt) : startMs;
          return [
            { key: stats.sessionId, initiativeId: stats.initiativeId, startMs, endMs, tokens },
          ];
        });
        const attribution = attributeQuota(
          list.map((observation) => ({
            checkedAtMs: Date.parse(observation.checkedAt),
            usedPercent: observation.usedPercent,
            resetsAt: observation.resetsAt,
          })),
          sessions,
        );
        let own = 0;
        let others = 0;
        for (const session of sessions) {
          const share = attribution.bySession.get(session.key) ?? 0;
          if (session.initiativeId === initiativeId) own += share;
          else others += share;
        }
        const round = (value: number) => Math.round(value * 10) / 10;
        shares.push({
          provider: latest.provider,
          accountId: latest.accountId,
          windowId: latest.windowId,
          windowKind: latest.windowKind,
          windowLabel: latest.windowLabel,
          usedPercent: latest.usedPercent,
          resetsAt: latest.resetsAt,
          checkedAt: latest.checkedAt,
          quality: latest.quality,
          method: "delta",
          initiativePercent: round(own),
          otherInitiativesPercent: round(others),
          unattributedPercent: round(Math.max(0, latest.usedPercent - own - others)),
          confidence: attributionConfidence({ observations: list.length, gaps: attribution.gaps }),
          observations: list.length,
        });
      }
      return shares.toSorted(
        (a, b) =>
          a.accountId.localeCompare(b.accountId) || a.windowKind.localeCompare(b.windowKind),
      );
    });

  /** Finished sessions of every initiative, as the basis of estimates. */
  const finishedSamples = (except: string | null) =>
    store.list("sessionStats").pipe(
      Effect.mapError(fromStore),
      Effect.map((all) =>
        all.filter((stats) => stats.outcome === "done" && stats.sessionId !== except).map(sampleOf),
      ),
    );

  const report = (initiativeId: string) =>
    Effect.gen(function* () {
      const [stats, sessions, samples] = yield* Effect.all([
        store.list("sessionStats", { initiativeId }).pipe(Effect.mapError(fromStore)),
        store.list("session", { initiativeId }).pipe(Effect.mapError(fromStore)),
        store.list("sessionStats").pipe(Effect.mapError(fromStore)),
      ]);
      const titles = new Map(sessions.map((session) => [session.id, session.title]));
      const finished = samples.filter((sample) => sample.outcome === "done");
      const accounts = new Set(stats.map((entry) => entry.provider));
      return {
        sessions: stats
          .filter((entry) => titles.has(entry.sessionId))
          .toSorted((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
          .map((entry) => ({
            sessionId: entry.sessionId,
            title: titles.get(entry.sessionId) ?? "",
            stats: entry,
            // Leave the session itself out, so the range is a real forecast for it.
            estimate: estimateFrom(
              entry,
              finished.filter((sample) => sample.sessionId !== entry.sessionId).map(sampleOf),
            ),
          })),
        quota: yield* quotaShares(initiativeId, accounts),
        measuredAt:
          stats
            .map((entry) => entry.measuredAt)
            .toSorted()
            .at(-1) ?? null,
      } satisfies InitiativeStatsReport;
    });

  const estimate = (initiativeId: string | null, provider: string, model: string | null) =>
    Effect.gen(function* () {
      return {
        estimate: estimateFrom({ provider, model }, yield* finishedSamples(null)),
        quota: yield* quotaShares(initiativeId, new Set([provider])),
      };
    });

  return { refresh, recordQuota, report, estimate, nowIso };
};

export type InitiativeStats = ReturnType<typeof makeInitiativeStats>;
