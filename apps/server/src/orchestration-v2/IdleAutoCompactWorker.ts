/**
 * Fork: idle auto-compact for Claude threads.
 *
 * A Claude subscription session caches its prompt for an hour. When a long
 * thread sits idle past that hour, the next message rewrites the whole
 * transcript into the cache. Compacting shortly before the cache expires reads
 * the transcript once more at the cheap cache rate and leaves a summary, so
 * the next message only writes that summary.
 *
 * @module IdleAutoCompactWorker
 */
import {
  CommandId,
  IDLE_AUTO_COMPACT_MESSAGE_ID_PREFIX,
  MessageId,
  ProviderDriverKind,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const CACHE_TTL_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export type IdleAutoCompactShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "activeRunId"
  | "activeProviderThreadId"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "latestUserMessageAt"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
>;

export type IdleAutoCompactRecords = Pick<
  OrchestrationV2ThreadProjection,
  "providerThreads" | "providerTurns" | "attempts"
>;

export type IdleAutoCompactPreferences = Pick<
  ServerSettingsValue,
  "enableIdleAutoCompact" | "idleAutoCompactAfterMinutes" | "idleAutoCompactMinContextTokens"
>;

export type IdleAutoCompactSkipReason =
  | "disabled"
  | "run-active"
  | "no-run"
  | "no-provider-thread"
  | "pending-request"
  | "background-tasks"
  | "archived"
  | "settled"
  | "too-early"
  | "cache-expired"
  | "not-claude"
  | "no-usage"
  | "ttl-not-1h"
  | "below-min-context"
  | "cache-refresh-expired";

/**
 * Cheap shell-only check: why an idle thread cannot be compacted now, or null
 * when it sits inside the window of a live cache. A finished thread's shell
 * status is its latest run's terminal status; "idle" only means it never ran.
 */
export function idleAutoCompactShellSkipReason(
  shell: IdleAutoCompactShell,
  preferences: IdleAutoCompactPreferences,
  nowMs: number,
): IdleAutoCompactSkipReason | null {
  if (shell.latestRunId === null) return "no-run";
  if (
    shell.activeRunId !== null ||
    shell.status === "idle" ||
    !ThreadManagement.isTerminalRunStatus(shell.status) ||
    !shell.latestRunCompletedAt
  )
    return "run-active";
  if (shell.activeProviderThreadId === null) return "no-provider-thread";
  if (shell.pendingRuntimeRequest !== null) return "pending-request";
  if ((shell.pendingBackgroundTasks?.length ?? 0) > 0) return "background-tasks";
  if (shell.archivedAt !== null || shell.deletedAt !== null) return "archived";
  if (shell.settledOverride === "settled") return "settled";
  const idleMs = nowMs - lastActivityMs(shell);
  if (idleMs < preferences.idleAutoCompactAfterMinutes * 60_000) return "too-early";
  // A run's last response refreshes the cache, so a run older than the TTL left none behind.
  if (idleMs >= CACHE_TTL_MS) return "cache-expired";
  return null;
}

function lastActivityMs(shell: IdleAutoCompactShell): number {
  return Math.max(
    shell.latestRunCompletedAt ? DateTime.toEpochMillis(shell.latestRunCompletedAt) : 0,
    shell.latestUserMessageAt ? DateTime.toEpochMillis(shell.latestUserMessageAt) : 0,
  );
}

/** The latest usage report of the thread's own transcript, not of a subagent's. */
function latestRootTokenUsage(records: IdleAutoCompactRecords, providerThreadId: string) {
  const providerThread = records.providerThreads.find((thread) => thread.id === providerThreadId);
  const nativeId = providerThread?.nativeThreadRef?.nativeId;
  if (providerThread?.driver !== CLAUDE_DRIVER || nativeId === undefined) return null;
  const attempts = new Map(records.attempts.map((attempt) => [attempt.id, attempt]));
  let latest:
    | NonNullable<IdleAutoCompactRecords["providerTurns"][number]["tokenUsage"]>
    | undefined;
  for (const turn of records.providerTurns) {
    if (turn.providerThreadId !== providerThreadId || !turn.tokenUsage || !turn.runAttemptId)
      continue;
    const attempt = attempts.get(turn.runAttemptId);
    if (attempt?.nativeThreadId !== nativeId || attempt.rootNodeId !== turn.nodeId) continue;
    if (latest === undefined || turn.tokenUsage.updatedAt > latest.updatedAt) {
      latest = turn.tokenUsage;
    }
  }
  return latest;
}

export type IdleAutoCompactDecision = {
  readonly command: OrchestrationV2Command | null;
  readonly skipReason: IdleAutoCompactSkipReason | null;
  /** What the decision saw, for the sweep log. */
  readonly lastActivityAt: string | null;
  readonly idleMinutes: number | null;
  readonly contextTokens?: number;
  readonly contextSource?: string;
  readonly cacheTtl?: string;
  readonly cacheRefreshedAt?: string;
};

/**
 * Whether to send `/compact` to an idle Claude thread now, and why not. The
 * command's ids derive from the cache refresh it saves, so one cache window is
 * compacted at most once: after a compact nothing new is cached until the
 * thread is used again. `records` is only read when the shell qualifies.
 */
export function idleAutoCompactDecision(input: {
  readonly shell: IdleAutoCompactShell;
  readonly records: () => IdleAutoCompactRecords;
  readonly preferences: IdleAutoCompactPreferences;
  readonly nowMs: number;
}): IdleAutoCompactDecision {
  const { shell, preferences, nowMs } = input;
  const activityMs = lastActivityMs(shell);
  const seen = {
    lastActivityAt: activityMs > 0 ? DateTime.formatIso(DateTime.makeUnsafe(activityMs)) : null,
    idleMinutes: activityMs > 0 ? Math.floor((nowMs - activityMs) / 60_000) : null,
  };
  const skip = (skipReason: IdleAutoCompactSkipReason, extra = {}): IdleAutoCompactDecision => ({
    command: null,
    skipReason,
    ...seen,
    ...extra,
  });
  if (!preferences.enableIdleAutoCompact) return skip("disabled");
  const shellReason = idleAutoCompactShellSkipReason(shell, preferences, nowMs);
  if (shellReason !== null) return skip(shellReason);
  const usage = latestRootTokenUsage(input.records(), shell.activeProviderThreadId!);
  if (usage === null) return skip("not-claude");
  if (usage === undefined) return skip("no-usage");
  // usedTokens counts input, cache reads and cache writes: Claude's prompt is almost all cache.
  const context = {
    contextTokens: usage.usedTokens,
    contextSource: "latest root usage report (input + cache read + cache write + output)",
    ...(usage.promptCache === undefined
      ? {}
      : { cacheTtl: usage.promptCache.ttl, cacheRefreshedAt: usage.promptCache.refreshedAt }),
  };
  // A 5m cache (API keys, overage) is long gone by now; a compact report carries no cache.
  if (usage.promptCache?.ttl !== "1h") return skip("ttl-not-1h", context);
  if (usage.usedTokens < preferences.idleAutoCompactMinContextTokens)
    return skip("below-min-context", context);
  const refreshedAtMs = Date.parse(usage.promptCache.refreshedAt);
  if (!Number.isFinite(refreshedAtMs) || nowMs - refreshedAtMs >= CACHE_TTL_MS)
    return skip("cache-refresh-expired", context);
  const identity = `${IDLE_AUTO_COMPACT_MESSAGE_ID_PREFIX}${shell.id}:${refreshedAtMs}`;
  return {
    command: {
      type: "message.dispatch",
      commandId: CommandId.make(identity),
      messageId: MessageId.make(identity),
      threadId: shell.id,
      text: "/compact",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    },
    skipReason: null,
    ...seen,
    ...context,
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  let lastSweepMs = 0;
  // Identities already sent; a repeated dispatch would only be refused.
  const dispatched = new Set<string>();
  // Each thread's last logged decision, so the log records changes, not every minute.
  const loggedReasons = new Map<string, string>();
  return Effect.fn("IdleAutoCompactWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    if (!preferences.enableIdleAutoCompact) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = nowMs;
    const snapshot = yield* projections.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
    });
    const seenThreads = new Set<string>();
    for (const shell of snapshot.threads) {
      seenThreads.add(shell.id);
      let records: IdleAutoCompactRecords | undefined;
      if (idleAutoCompactShellSkipReason(shell, preferences, nowMs) === null) {
        records = yield* projections.getThreadRecords(shell.id, [
          "providerThreads",
          "providerTurns",
          "attempts",
        ]);
      }
      const decision = idleAutoCompactDecision({
        shell,
        records: () => records!,
        preferences,
        nowMs,
      });
      const { command } = decision;
      const alreadyDispatched = command !== null && dispatched.has(command.commandId);
      const result = command === null ? "skip" : alreadyDispatched ? "skip" : "compact";
      const reason = alreadyDispatched ? "already-dispatched" : decision.skipReason;
      const logKey = `${result}:${reason}`;
      if (loggedReasons.get(shell.id) !== logKey) {
        loggedReasons.set(shell.id, logKey);
        yield* Effect.logInfo("orchestration-v2.idle-auto-compact.decision", {
          threadId: shell.id,
          result,
          ...(reason === null ? {} : { reason }),
          lastActivityAt: decision.lastActivityAt,
          idleMinutes: decision.idleMinutes,
          contextTokens: decision.contextTokens,
          contextSource: decision.contextSource,
          cacheTtl: decision.cacheTtl,
          cacheRefreshedAt: decision.cacheRefreshedAt,
        });
      }
      if (command === null || alreadyDispatched) continue;
      dispatched.add(command.commandId);
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.idle-auto-compact.dispatch-failed", {
            threadId: shell.id,
            cause,
          }),
        ),
      );
    }
    for (const threadId of loggedReasons.keys()) {
      if (!seenThreads.has(threadId)) loggedReasons.delete(threadId);
    }
  });
});

// Due work derives from persisted runs and usage reports, so a restart needs no timers.
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("idle-auto-compact", sweep());
  }),
);
