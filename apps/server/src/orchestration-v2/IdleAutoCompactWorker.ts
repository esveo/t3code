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

/** Cheap shell-only check: idle, untouched, and inside the window of a live cache. */
export function isIdleAutoCompactCandidate(
  shell: IdleAutoCompactShell,
  preferences: IdleAutoCompactPreferences,
  nowMs: number,
): boolean {
  if (
    shell.status !== "idle" ||
    shell.activeRunId !== null ||
    shell.latestRunId === null ||
    shell.activeProviderThreadId === null ||
    shell.pendingRuntimeRequest !== null ||
    (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
    shell.archivedAt !== null ||
    shell.deletedAt !== null ||
    shell.settledOverride === "settled" ||
    !shell.latestRunCompletedAt
  )
    return false;
  const idleMs = nowMs - lastActivityMs(shell);
  // A run's last response refreshes the cache, so a run older than the TTL left none behind.
  return idleMs >= preferences.idleAutoCompactAfterMinutes * 60_000 && idleMs < CACHE_TTL_MS;
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
  if (providerThread?.driver !== CLAUDE_DRIVER || nativeId === undefined) return undefined;
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

/**
 * The `/compact` to send to an idle Claude thread, or null. Its ids derive from
 * the cache refresh it saves, so one cache window is compacted at most once:
 * after a compact nothing new is cached until the thread is used again.
 */
export function idleAutoCompactCommand(input: {
  readonly shell: IdleAutoCompactShell;
  readonly records: IdleAutoCompactRecords;
  readonly preferences: IdleAutoCompactPreferences;
  readonly nowMs: number;
}): OrchestrationV2Command | null {
  const { shell, preferences, nowMs } = input;
  if (!preferences.enableIdleAutoCompact || !isIdleAutoCompactCandidate(shell, preferences, nowMs))
    return null;
  const usage = latestRootTokenUsage(input.records, shell.activeProviderThreadId!);
  // A 5m cache (API keys, overage) is long gone by now; a compact report carries no cache.
  if (
    usage?.promptCache?.ttl !== "1h" ||
    usage.usedTokens < preferences.idleAutoCompactMinContextTokens
  )
    return null;
  const refreshedAtMs = Date.parse(usage.promptCache.refreshedAt);
  if (!Number.isFinite(refreshedAtMs) || nowMs - refreshedAtMs >= CACHE_TTL_MS) return null;
  const identity = `${IDLE_AUTO_COMPACT_MESSAGE_ID_PREFIX}${shell.id}:${refreshedAtMs}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: shell.id,
    text: "/compact",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  let lastSweepMs = 0;
  // Identities already sent; a repeated dispatch would only be refused.
  const dispatched = new Set<string>();
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
    for (const shell of snapshot.threads) {
      if (!isIdleAutoCompactCandidate(shell, preferences, nowMs)) continue;
      const records = yield* projections.getThreadRecords(shell.id, [
        "providerThreads",
        "providerTurns",
        "attempts",
      ]);
      const command = idleAutoCompactCommand({ shell, records, preferences, nowMs });
      if (command === null || dispatched.has(command.commandId)) continue;
      dispatched.add(command.commandId);
      yield* Effect.logInfo("orchestration-v2.idle-auto-compact.dispatch", {
        threadId: shell.id,
      });
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.idle-auto-compact.dispatch-failed", {
            threadId: shell.id,
            cause,
          }),
        ),
      );
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
