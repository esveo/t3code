/**
 * Fork: user insights. Learns how the user writes and works from the
 * messages they type, in the background and only while
 * `enableUserInsights` is on.
 *
 * Each observed message leaves a redacted evidence record (no model call).
 * A one-minute tick decides from `state.json` whether enough evidence waits;
 * then one Haiku call proposes operations on the profile, which code
 * validates and merges. Every call lands in `usage.jsonl` and counts against
 * the daily caps. Everything lives in `<stateDir>/user-insights/`.
 *
 * File access goes through one lock; the model call itself runs outside it
 * (under its own lock, so one distill at a time), so observing never waits
 * on Haiku.
 *
 * Once the profile is ready, a client asks for next-message suggestions after
 * a finished turn. One set per thread and turn: a second window on the same
 * turn shares the first one's call. The user's next message in that thread
 * tells whether the set was taken, which feeds throttling and the next distill.
 *
 * An import learns from messages typed before insights were on: it queues
 * them in `import.jsonl` and works through them in batches of 30 on a
 * background fiber, one model call per batch and never alongside a distill.
 */
import {
  USER_INSIGHTS_DAILY_COST_CAP_USD,
  USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH,
  USER_INSIGHTS_READY_SAMPLES,
  USER_INSIGHTS_TRAIT_IDS,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  type UserInsightsAction,
  type UserInsightsActResult,
  UserInsightsError,
  type UserInsightsImportPreview,
  type UserInsightsProfile,
  type UserInsightsSnapshot,
  type UserInsightsStatus,
  type UserInsightsSuggestResult,
  type UserInsightsSuggestSkip,
  type UserInsightsTraitId,
  type UserInsightsUsageSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  distillDecision,
  emptyState,
  type ImportCursor,
  isBackingOff,
  isOverBudget,
  MAX_DISTILLS_PER_DAY,
  MAX_SUGGESTS_PER_DAY,
  pauseReason,
  recordCall,
  recordFailure,
  recordSuccess,
  rollDay,
  type UserInsightsState,
  utcDay,
} from "./distillPolicy.ts";
import { isObservableUserMessage, makeSeenIds, toEvidence } from "./evidence.ts";
import { emptyUsage, type ModelUsage, UserInsightsModel } from "./HaikuCli.ts";
import {
  batchCount,
  batchWeight,
  estimateImportCost,
  IMPORT_BATCH_SIZE,
  IMPORT_MAX_AGE_DAYS,
  type PastThread,
  selectPastMessages,
} from "./importPast.ts";
import {
  applyOps,
  deleteTrait as deleteProfileTrait,
  editTrait as editProfileTrait,
  emptyProfile,
  isProfileReady,
  validateOps,
} from "./profileMerge.ts";
import {
  buildDistillPrompt,
  buildSuggestPrompt,
  DistillOutput,
  sanitizeSuggestions,
  selectDistillEvidence,
  SuggestOutput,
} from "./prompts.ts";
import { EVIDENCE_MAX_RECORDS, makeUserInsightsStore, type UsageRecord } from "./store.ts";
import {
  acceptanceLevel,
  classifyOutcome,
  countEligibleTurn,
  muteThread,
  recordOutcome,
  suggestGate,
} from "./suggestPolicy.ts";
import { DAY_MS, fromIso, toIso } from "./time.ts";

export type DistillResult =
  | { readonly kind: "distilled"; readonly applied: number; readonly rejected: number }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: string };

export class UserInsights extends Context.Service<
  UserInsights,
  {
    /** Follows typed user messages and runs the distill tick, once the server accepts commands. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Records one domain event if it is a message the user typed. */
    readonly observe: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** One tick: distills when the policy says so. */
    readonly tick: Effect.Effect<DistillResult>;
    /** Distills whatever is pending now, ignoring the timing but not the caps. */
    readonly distillNow: Effect.Effect<DistillResult>;
    readonly snapshot: Effect.Effect<UserInsightsSnapshot, UserInsightsError>;
    /** Sets a trait's value and pins it against model revisions. */
    readonly editTrait: (
      id: UserInsightsTraitId,
      value: string,
    ) => Effect.Effect<void, UserInsightsError>;
    readonly deleteTrait: (id: UserInsightsTraitId) => Effect.Effect<void, UserInsightsError>;
    /** Puts back the profile before its last change. */
    readonly undo: Effect.Effect<void, UserInsightsError>;
    /** Forgets everything learned; keeps the usage ledger. */
    readonly reset: Effect.Effect<void, UserInsightsError>;
    /** Removes the whole folder. */
    readonly deleteAll: Effect.Effect<void, UserInsightsError>;
    /**
     * Next-message suggestions for the thread's finished latest turn, at most
     * one model call per turn. Empty with a reason when none are due.
     */
    readonly suggest: (threadId: ThreadId) => Effect.Effect<UserInsightsSuggestResult>;
    /** One user action from a client: suggestion feedback, mute, profile control and import. */
    readonly act: (
      action: UserInsightsAction,
    ) => Effect.Effect<UserInsightsActResult, UserInsightsError>;
    /** Queues the past messages an import learns from, without running it. */
    readonly queueImport: Effect.Effect<UserInsightsImportPreview, UserInsightsError>;
    /** Works through the queued import batch by batch until it is done or has to wait; returns the batches learned from. */
    readonly runImport: Effect.Effect<number>;
  }
>()("t3/userInsights/UserInsights") {}

const TICK_INTERVAL = "1 minute";
/** Suggestion sets remembered per turn, so other windows reuse them. */
const MAX_REMEMBERED_SETS = 200;

/** A shown set, until the user's next message in its thread says what became of it. */
interface OpenSet {
  readonly setId: string;
  readonly labels: ReadonlyArray<string>;
  readonly prompts: ReadonlyArray<string>;
  readonly filledIndex: number | null;
}

const skipped = (reason: UserInsightsSuggestSkip): UserInsightsSuggestResult => ({
  setId: null,
  suggestions: [],
  skipped: reason,
});

const traitOrder = (id: string) => (USER_INSIGHTS_TRAIT_IDS as ReadonlyArray<string>).indexOf(id);

const sumUsage = (records: ReadonlyArray<UsageRecord>) => {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const record of records) {
    inputTokens += record.inputTokens + record.cacheReadTokens + record.cacheCreationTokens;
    outputTokens += record.outputTokens;
    costUsd += record.costUsd;
  }
  return { calls: records.length, inputTokens, outputTokens, costUsd };
};

/** Today (UTC), the last seven days and all time, from the usage ledger. */
export function summarizeUsage(
  records: ReadonlyArray<UsageRecord>,
  input: { readonly now: number; readonly lastDistillAt: string | null },
): UserInsightsUsageSummary {
  const today = utcDay(input.now);
  return {
    today: sumUsage(records.filter((record) => record.ts.slice(0, 10) === today)),
    last7Days: sumUsage(records.filter((record) => input.now - fromIso(record.ts) <= 7 * DAY_MS)),
    total: sumUsage(records),
    lastDistillAt: input.lastDistillAt,
    dailyCapUsd: USER_INSIGHTS_DAILY_COST_CAP_USD,
    maxDistillsPerDay: MAX_DISTILLS_PER_DAY,
    maxSuggestsPerDay: MAX_SUGGESTS_PER_DAY,
  };
}

const failure = (message: string) => new UserInsightsError({ message });

export const make = Effect.gen(function* () {
  /** Owns the import fiber, so it ends with the service. */
  const serviceScope = yield* Effect.scope;
  const threads = yield* ThreadManagementService;
  const settingsService = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const model = yield* UserInsightsModel;
  const store = yield* makeUserInsightsStore(config.stateDir);
  const io = yield* Semaphore.make(1);
  const distilling = yield* Semaphore.make(1);
  const isNew = makeSeenIds();
  /** Shown sets by thread id. */
  const openSets = new Map<string, OpenSet>();
  /** Suggest results by set id (thread and turn), including calls still running. */
  const sets = new Map<string, Deferred.Deferred<UserInsightsSuggestResult>>();
  /** Bumped by reset and delete, so a model call still running discards its result. */
  let generation = 0;
  const forgetLearned = Effect.sync(() => {
    generation += 1;
    openSets.clear();
    sets.clear();
  });

  const settings = settingsService.getSettings.pipe(Effect.option);
  const enabled = settings.pipe(
    Effect.map((value) => Option.isSome(value) && value.value.enableUserInsights),
  );
  /**
   * What a finished model call may still do: nothing once insights were
   * turned off meanwhile, only the ledger once the data was reset or deleted
   * (and the folder is still there), or everything.
   */
  const afterCall = (startGeneration: number) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return "nothing" as const;
      if (generation === startGeneration) return "everything" as const;
      return (yield* store.exists) ? ("ledger-only" as const) : ("nothing" as const);
    });
  const loadState = (now: number) =>
    store.readState.pipe(Effect.map((state) => rollDay(state ?? emptyState(now), now)));
  const loadProfile = (now: number) =>
    store.readProfile.pipe(Effect.map((profile) => profile ?? emptyProfile(now)));
  const locked = io.withPermits(1);

  const observe: UserInsights["Service"]["observe"] = (event) =>
    Effect.gen(function* () {
      if (!isObservableUserMessage(event)) return;
      if (!(yield* enabled)) return;
      if (!isNew(event.payload.id)) return;
      const shell = yield* threads
        .getThreadShell(event.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const now = yield* Clock.currentTimeMillis;
      const record = toEvidence({
        message: event.payload,
        projectId: shell?.projectId ?? null,
        now,
      });
      const open = openSets.get(event.threadId);
      openSets.delete(event.threadId);
      yield* locked(
        Effect.gen(function* () {
          yield* store.appendEvidence(record);
          let state = yield* loadState(now);
          if (open !== undefined) {
            const filled =
              open.filledIndex === null ? null : (open.prompts[open.filledIndex] ?? null);
            const outcome = classifyOutcome(filled, event.payload.text);
            yield* store.appendFeedback({
              ts: toIso(now),
              threadId: event.threadId,
              setId: open.setId,
              labels: open.labels,
              outcome,
              ...(open.filledIndex === null ? {} : { index: open.filledIndex }),
            });
            state = recordOutcome(state, event.threadId, outcome, now);
          }
          const pendingEvidence = state.pendingEvidence + 1;
          yield* store.writeState({
            ...state,
            pendingEvidence,
            lastMessageAt: toIso(now),
            firstPendingAt:
              state.pendingEvidence === 0 || !state.firstPendingAt
                ? toIso(now)
                : state.firstPendingAt,
          });
          // Distills trim the files; when none succeeds for a long time
          // (Claude off, backoff), the evidence must not grow without end.
          if (pendingEvidence % EVIDENCE_MAX_RECORDS === 0) yield* store.trim(now);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("user-insights.observe-failed", { cause })),
    );

  const usageRecord = (input: {
    readonly purpose: UsageRecord["purpose"];
    readonly now: number;
    readonly usage: ModelUsage;
    readonly ok: boolean;
    readonly error?: string;
  }): UsageRecord => ({
    ts: toIso(input.now),
    purpose: input.purpose,
    model: input.usage.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheCreationTokens: input.usage.cacheCreationTokens,
    costUsd: input.usage.costUsd,
    costEstimated: input.usage.costEstimated,
    durationMs: input.usage.durationMs,
    ok: input.ok,
    ...(input.error === undefined ? {} : { error: input.error }),
  });

  const distill = (force: boolean): Effect.Effect<DistillResult> =>
    distilling
      .withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* enabled)) return { kind: "skipped", reason: "disabled" } as const;
          const startedAt = yield* Clock.currentTimeMillis;
          const prepared = yield* locked(
            Effect.gen(function* () {
              const state = yield* loadState(startedAt);
              const decision = distillDecision(state, { enabled: true }, startedAt);
              const timingOnly =
                decision.kind === "skip" &&
                (decision.reason === "waiting" || decision.reason === "not-enough");
              if (decision.kind === "skip" && !(force && timingOnly && state.pendingEvidence > 0)) {
                return {
                  kind: "skip",
                  reason: decision.kind === "skip" ? decision.reason : "",
                } as const;
              }
              const evidence = yield* store.readEvidence;
              const pending = evidence.slice(-state.pendingEvidence);
              const selected = selectDistillEvidence(pending);
              if (selected.length === 0) {
                // The evidence is gone (trimmed or deleted by hand); start over.
                yield* store.writeState({ ...state, pendingEvidence: 0, firstPendingAt: null });
                return { kind: "skip", reason: "no-evidence" } as const;
              }
              const profile = yield* loadProfile(startedAt);
              const since = state.lastDistillAt === null ? 0 : fromIso(state.lastDistillAt);
              const feedback = (yield* store.readFeedback).filter(
                (entry) => fromIso(entry.ts) > since,
              );
              return {
                kind: "run",
                consumed: state.pendingEvidence,
                selected,
                prompt: buildDistillPrompt({ profile, evidence: selected, feedback }),
              } as const;
            }),
          );
          if (prepared.kind === "skip")
            return { kind: "skipped", reason: prepared.reason } as const;

          const startGeneration = generation;
          const outcome = yield* model
            .run({ prompt: prepared.prompt, outputSchema: DistillOutput })
            .pipe(
              Effect.map((result) => ({ ok: true, ...result }) as const),
              Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
            );
          const endedAt = yield* Clock.currentTimeMillis;
          if (!outcome.ok && outcome.error.reason === "unavailable") {
            return { kind: "skipped", reason: "claude-unavailable" } as const;
          }
          const usage = (() => {
            const reported = outcome.ok ? outcome.usage : (outcome.error.usage ?? emptyUsage());
            return reported.durationMs > 0
              ? reported
              : { ...reported, durationMs: endedAt - startedAt };
          })();

          return yield* locked(
            Effect.gen(function* () {
              // Turned off or deleted during the call: leave the folder alone.
              const allowed = yield* afterCall(startGeneration);
              if (allowed === "nothing") return { kind: "skipped", reason: "disabled" } as const;
              let state = recordCall(yield* loadState(endedAt), {
                purpose: "distill",
                costUsd: usage.costUsd,
              });
              if (!outcome.ok) {
                yield* store.appendUsage(
                  usageRecord({
                    purpose: "distill",
                    now: endedAt,
                    usage,
                    ok: false,
                    error: outcome.error.message,
                  }),
                );
                yield* store.writeState(recordFailure(state, endedAt));
                yield* Effect.logWarning("user-insights.distill-failed", {
                  message: outcome.error.message,
                });
                return { kind: "failed", message: outcome.error.message } as const;
              }
              yield* store.appendUsage(
                usageRecord({ purpose: "distill", now: endedAt, usage, ok: true }),
              );
              if (allowed === "ledger-only") {
                // Reset during the call: the ops describe evidence that is gone.
                yield* store.writeState(state);
                return { kind: "skipped", reason: "reset" } as const;
              }
              // Merge onto the profile as it is now, so a user edit made
              // during the call is not lost.
              const profile = yield* loadProfile(endedAt);
              const { accepted, rejected } = validateOps(outcome.output.ops, {
                profile,
                excerptCount: prepared.selected.length,
              });
              if (rejected.length > 0) {
                yield* Effect.logDebug("user-insights.ops-rejected", {
                  reasons: rejected.map((entry) => `${entry.op.traitId}: ${entry.reason}`),
                });
              }
              yield* store.writeProfile(
                applyOps(profile, accepted, {
                  now: endedAt,
                  evidenceIds: prepared.selected.map((record) => record.messageId),
                  newSamples: prepared.consumed,
                }),
              );
              state = recordSuccess(state, prepared.consumed, endedAt);
              yield* store.writeState(state);
              yield* store.trim(endedAt);
              return {
                kind: "distilled",
                applied: accepted.length,
                rejected: rejected.length,
              } as const;
            }),
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("user-insights.distill-error", { cause }).pipe(
            Effect.as<DistillResult>({ kind: "failed", message: "Unexpected error." }),
          ),
        ),
      );

  const tick = distill(false);
  const distillNow = distill(true);

  /** Every thread's messages from the last 30 days; a thread that cannot be read is skipped. */
  const readPastThreads = (now: number) =>
    Effect.gen(function* () {
      const cutoff = now - IMPORT_MAX_AGE_DAYS * DAY_MS;
      const snapshot = yield* threads
        .getShellSnapshot()
        .pipe(Effect.mapError(() => failure("Could not read the past threads.")));
      const recent = [...snapshot.threads, ...snapshot.archivedThreads].filter((shell) => {
        if (shell.lineage.relationshipToParent === "subagent") return false;
        const lastActive = shell.latestUserMessageAt ?? shell.updatedAt;
        return DateTime.toEpochMillis(lastActive) >= cutoff;
      });
      return yield* Effect.forEach(
        recent,
        (shell) =>
          threads
            .getThreadRecords(shell.id, ["messages"], { messageRoles: ["user", "assistant"] })
            .pipe(
              Effect.map(({ messages }): PastThread => ({ projectId: shell.projectId, messages })),
              Effect.orElseSucceed((): PastThread => ({
                projectId: shell.projectId,
                messages: [],
              })),
            ),
        { concurrency: 4 },
      );
    });

  const selectImport = (now: number) =>
    Effect.gen(function* () {
      const past = yield* readPastThreads(now);
      const { evidence, usage } = yield* locked(
        Effect.all({ evidence: store.readEvidence, usage: store.readUsage }),
      );
      const records = selectPastMessages(past, {
        now,
        knownIds: new Set(evidence.map((record) => record.messageId)),
      });
      const batches = batchCount(records.length);
      return {
        records,
        preview: {
          messages: records.length,
          batches,
          estimatedCostUsd: estimateImportCost(usage, batches),
        } satisfies UserInsightsImportPreview,
      };
    });

  const requireEnabled = enabled.pipe(
    Effect.flatMap((on) =>
      on ? Effect.void : Effect.fail(failure("Turn on user insights first.")),
    ),
  );

  const previewImport = requireEnabled.pipe(
    Effect.andThen(Clock.currentTimeMillis),
    Effect.flatMap(selectImport),
    Effect.map((selected) => selected.preview),
  );

  const queueImport: UserInsights["Service"]["queueImport"] = Effect.gen(function* () {
    yield* requireEnabled;
    const now = yield* Clock.currentTimeMillis;
    const { records, preview } = yield* selectImport(now);
    if (records.length === 0) return yield* failure("There are no past messages to import.");
    yield* locked(
      Effect.gen(function* () {
        const state = yield* loadState(now);
        if (state.import?.state === "running") {
          return yield* failure("An import is already running.");
        }
        yield* store.writeImportQueue(records);
        yield* store.writeState({
          ...state,
          import: {
            id: `import-${now}`,
            state: "running",
            done: 0,
            total: records.length,
            startedAt: toIso(now),
          },
        });
      }),
    );
    return preview;
  });

  /**
   * One import batch: the next 30 queued records, one model call, merged with
   * their age weight and moved into the evidence, so a later import skips
   * them. Waits (returns "stop") at the cost cap, in backoff, or while off;
   * the tick resumes it. Cancel, reset and delete during the call drop it.
   * A failed call returns "retry" when `mayRetry`, so one hiccup of the CLI
   * does not pause the import (and live learning) for 15 minutes.
   */
  const importBatch = (
    mayRetry: boolean,
  ): Effect.Effect<"learned" | "finished" | "retry" | "stop"> =>
    distilling
      .withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* enabled)) return "stop" as const;
          const startedAt = yield* Clock.currentTimeMillis;
          const prepared = yield* locked(
            Effect.gen(function* () {
              const state = yield* loadState(startedAt);
              const cursor = state.import;
              if (cursor?.state !== "running") return null;
              if (isOverBudget(state) || isBackingOff(state, startedAt)) return null;
              const batch = (yield* store.readImportQueue).slice(
                cursor.done,
                cursor.done + IMPORT_BATCH_SIZE,
              );
              if (batch.length === 0) {
                // The queue is gone (deleted by hand); end the import where it is.
                yield* store.writeState({ ...state, import: { ...cursor, state: "done" } });
                yield* store.removeImportQueue;
                return null;
              }
              // Shown newest first, like a distill.
              const shown = batch.toReversed();
              return {
                cursor,
                batch,
                shown,
                prompt: buildDistillPrompt({
                  profile: yield* loadProfile(startedAt),
                  evidence: shown,
                }),
              };
            }),
          );
          if (prepared === null) return "stop" as const;

          const startGeneration = generation;
          const outcome = yield* model
            .run({ prompt: prepared.prompt, outputSchema: DistillOutput })
            .pipe(
              Effect.map((result) => ({ ok: true, ...result }) as const),
              Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
            );
          const endedAt = yield* Clock.currentTimeMillis;
          if (!outcome.ok && outcome.error.reason === "unavailable") return "stop" as const;
          const reported = outcome.ok ? outcome.usage : (outcome.error.usage ?? emptyUsage());
          const usage =
            reported.durationMs > 0 ? reported : { ...reported, durationMs: endedAt - startedAt };

          return yield* locked(
            Effect.gen(function* () {
              const allowed = yield* afterCall(startGeneration);
              if (allowed === "nothing") return "stop" as const;
              const state = recordCall(yield* loadState(endedAt), {
                purpose: "import",
                costUsd: usage.costUsd,
              });
              yield* store.appendUsage(
                usageRecord({
                  purpose: "import",
                  now: endedAt,
                  usage,
                  ok: outcome.ok,
                  ...(outcome.ok ? {} : { error: outcome.error.message }),
                }),
              );
              if (!outcome.ok) {
                yield* store.writeState(mayRetry ? state : recordFailure(state, endedAt));
                yield* Effect.logWarning("user-insights.import-failed", {
                  message: outcome.error.message,
                  retry: mayRetry,
                });
                return mayRetry ? ("retry" as const) : ("stop" as const);
              }
              const cursor = state.import;
              const current =
                allowed === "everything" &&
                cursor?.id === prepared.cursor.id &&
                cursor.state === "running" &&
                cursor.done === prepared.cursor.done;
              if (!current) {
                // Cancelled or reset during the call: only the cost counts.
                yield* store.writeState(state);
                return "stop" as const;
              }
              const profile = yield* loadProfile(endedAt);
              const { accepted } = validateOps(outcome.output.ops, {
                profile,
                excerptCount: prepared.shown.length,
              });
              yield* store.writeProfile(
                applyOps(profile, accepted, {
                  now: endedAt,
                  evidenceIds: prepared.shown.map((record) => record.messageId),
                  newSamples: prepared.batch.length,
                  weight: batchWeight(prepared.batch, endedAt),
                }),
              );
              // Before the pending tail, which the next distill takes from the end.
              const evidence = yield* store.readEvidence;
              const at = Math.max(0, evidence.length - state.pendingEvidence);
              yield* store.writeEvidence([
                ...evidence.slice(0, at),
                ...prepared.batch,
                ...evidence.slice(at),
              ]);
              const done = cursor.done + prepared.batch.length;
              const finished = done >= cursor.total;
              yield* store.writeState({
                ...state,
                failures: 0,
                backoffUntil: null,
                import: { ...cursor, done, state: finished ? "done" : "running" },
              });
              if (finished) yield* store.removeImportQueue;
              yield* store.trim(endedAt);
              return finished ? ("finished" as const) : ("learned" as const);
            }),
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("user-insights.import-error", { cause }).pipe(
            Effect.as("stop" as const),
          ),
        ),
      );

  /** Set while a fiber works through the import, so there is only ever one. */
  let importing = false;
  const runImport: UserInsights["Service"]["runImport"] = Effect.suspend(() => {
    if (importing) return Effect.succeed(0);
    importing = true;
    return Effect.gen(function* () {
      let batches = 0;
      let result = yield* importBatch(true);
      while (result !== "stop") {
        if (result === "retry") {
          result = yield* importBatch(false);
          continue;
        }
        batches += 1;
        if (result === "finished") break;
        result = yield* importBatch(true);
      }
      return batches;
    }).pipe(Effect.ensuring(Effect.sync(() => (importing = false))));
  });
  const forkImport = Effect.forkIn(runImport, serviceScope).pipe(Effect.asVoid);

  /** On the tick: picks a waiting import back up (after a restart, the cap or a backoff). */
  const resumeImport = Effect.gen(function* () {
    if (importing || !(yield* enabled)) return;
    const now = yield* Clock.currentTimeMillis;
    const state = yield* locked(loadState(now));
    if (state.import?.state === "running") yield* forkImport;
  });

  const cancelImport = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* locked(
      Effect.gen(function* () {
        const state = yield* loadState(now);
        if (state.import?.state !== "running") return;
        yield* store.writeState({ ...state, import: { ...state.import, state: "cancelled" } });
        yield* store.removeImportQueue;
      }),
    );
  });

  const snapshot: UserInsights["Service"]["snapshot"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* settings;
    if (Option.isNone(current) || !current.value.enableUserInsights) {
      return {
        status: { state: "off" },
        traits: [],
        usage: summarizeUsage([], { now, lastDistillAt: null }),
        folderPath: store.directory,
        hasStoredData: yield* locked(store.exists),
      } satisfies UserInsightsSnapshot;
    }
    const { profile, state, usage, feedback } = yield* locked(
      Effect.all({
        profile: loadProfile(now),
        state: loadState(now),
        usage: store.readUsage,
        feedback: store.readFeedback,
      }),
    );
    return {
      status: statusOf({
        profile,
        state,
        claudeAvailable: current.value.providers.claudeAgent.enabled,
        lowAcceptance:
          current.value.enableUserInsightsSuggestions &&
          acceptanceLevel(feedback, state.acceptanceResetAt) === "paused",
        now,
      }),
      traits: [...profile.traits].toSorted((a, b) => traitOrder(a.id) - traitOrder(b.id)),
      usage: summarizeUsage(usage, { now, lastDistillAt: state.lastDistillAt }),
      folderPath: store.directory,
      hasStoredData: yield* locked(store.exists),
      import: importProgress(state.import),
    } satisfies UserInsightsSnapshot;
  });

  const changeProfile = (
    change: (profile: UserInsightsProfile, now: number) => UserInsightsProfile,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* locked(
        loadProfile(now).pipe(
          Effect.flatMap((profile) => store.writeProfile(change(profile, now))),
        ),
      );
    });

  const editTrait: UserInsights["Service"]["editTrait"] = (id, value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return Effect.fail(failure("A trait needs a value."));
    if (trimmed.length > USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH) {
      return Effect.fail(
        failure(`A trait is at most ${USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH} characters.`),
      );
    }
    return changeProfile((profile, now) => editProfileTrait(profile, id, trimmed, now));
  };

  const deleteTrait: UserInsights["Service"]["deleteTrait"] = (id) =>
    changeProfile((profile, now) => deleteProfileTrait(profile, id, now));

  const undo = locked(store.restorePreviousProfile).pipe(
    Effect.flatMap((restored) =>
      restored ? Effect.void : Effect.fail(failure("There is no earlier profile to go back to.")),
    ),
  );

  const start = () =>
    forkParked(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          threads.streamDomainEvents.pipe(
            Stream.runForEach(observe),
            Effect.catchCause((cause) =>
              Effect.logWarning("user-insights.stream-failed", { cause }),
            ),
          ),
        );
        yield* Effect.forkScoped(followSuggestionsToggle);
        yield* tick.pipe(
          Effect.andThen(resumeImport),
          Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
        );
      }),
    );

  const suggestionsOn = (
    value: Option.Option<{
      readonly enableUserInsights: boolean;
      readonly enableUserInsightsSuggestions: boolean;
    }>,
  ) =>
    Option.isSome(value) &&
    value.value.enableUserInsights &&
    value.value.enableUserInsightsSuggestions;

  /**
   * Turning suggestions back on clears a low-acceptance pause: acceptance
   * then only counts sets shown from now on.
   */
  const resetAcceptance = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* locked(
      loadState(now).pipe(
        Effect.flatMap((state) =>
          store.writeState({ ...state, acceptanceResetAt: toIso(now), eligibleSuggests: 0 }),
        ),
      ),
    );
  });

  const followSuggestionsToggle = Effect.gen(function* () {
    let wasOn = suggestionsOn(yield* settings);
    yield* settingsService.streamChanges.pipe(
      Stream.runForEach((next) => {
        const on = suggestionsOn(Option.some(next));
        const turnedOn = on && !wasOn;
        wasOn = on;
        return turnedOn ? resetAcceptance : Effect.void;
      }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("user-insights.settings-stream-failed", { cause }),
    ),
  );

  const rememberSet = (setId: string, deferred: Deferred.Deferred<UserInsightsSuggestResult>) => {
    sets.set(setId, deferred);
    if (sets.size > MAX_REMEMBERED_SETS) {
      const oldest = sets.keys().next().value;
      if (oldest !== undefined) sets.delete(oldest);
    }
  };

  /** A thread whose user never writes again must not keep its set forever. */
  const rememberOpenSet = (threadId: string, open: OpenSet) => {
    openSets.delete(threadId);
    openSets.set(threadId, open);
    if (openSets.size > MAX_REMEMBERED_SETS) {
      const oldest = openSets.keys().next().value;
      if (oldest !== undefined) openSets.delete(oldest);
    }
  };

  const lastText = (
    messages: ReadonlyArray<{
      readonly role: string;
      readonly text: string;
      readonly streaming: boolean;
    }>,
    role: "user" | "assistant",
  ) => {
    const found = messages.findLast(
      (message) => message.role === role && !message.streaming && message.text.trim().length > 0,
    );
    return found === undefined ? null : found.text;
  };

  /** The model call behind one new set; never fails, a failure is a skip. */
  const createSet = (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly setId: string;
    readonly title: string;
    readonly userText: string | null;
    readonly assistantText: string;
  }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const startGeneration = generation;
      const prepared = yield* locked(
        Effect.gen(function* () {
          const state = yield* loadState(startedAt);
          const feedback = yield* store.readFeedback;
          const counted = countEligibleTurn(
            state,
            acceptanceLevel(feedback, state.acceptanceResetAt),
          );
          yield* store.writeState(counted.state);
          if (!counted.allowed) return null;
          const profile = yield* loadProfile(startedAt);
          return buildSuggestPrompt({
            profile,
            threadTitle: input.title,
            userText: input.userText,
            assistantText: input.assistantText,
            feedback,
          });
        }),
      );
      if (prepared === null) return skipped("throttled");

      const outcome = yield* model.run({ prompt: prepared, outputSchema: SuggestOutput }).pipe(
        Effect.map((result) => ({ ok: true, ...result }) as const),
        Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
      );
      const endedAt = yield* Clock.currentTimeMillis;
      if (!outcome.ok && outcome.error.reason === "unavailable") return skipped("paused");
      const reported = outcome.ok ? outcome.usage : (outcome.error.usage ?? emptyUsage());
      const usage =
        reported.durationMs > 0 ? reported : { ...reported, durationMs: endedAt - startedAt };
      const allowed = yield* locked(
        Effect.gen(function* () {
          const allowed = yield* afterCall(startGeneration);
          if (allowed === "nothing") return allowed;
          yield* store.appendUsage(
            usageRecord({
              purpose: "suggest",
              now: endedAt,
              usage,
              ok: outcome.ok,
              ...(outcome.ok ? {} : { error: outcome.error.message }),
            }),
          );
          const state = yield* loadState(endedAt);
          yield* store.writeState(
            recordCall(state, { purpose: "suggest", costUsd: usage.costUsd }),
          );
          return allowed;
        }),
      );
      // Turned off or reset during the call: the profile it was based on is gone.
      if (allowed === "nothing") return skipped("off");
      if (allowed === "ledger-only") return skipped("not-ready");
      if (!outcome.ok) {
        yield* Effect.logWarning("user-insights.suggest-failed", {
          message: outcome.error.message,
        });
        return skipped("failed");
      }
      const suggestions = sanitizeSuggestions(outcome.output);
      if (suggestions.length === 0) return skipped("nothing-useful");
      // The user wrote on while the model ran: no client shows this set, so
      // their next message must not count as ignoring it.
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.latestRunId !== input.runId || shell.activeRunId !== null) {
        return skipped("not-idle");
      }
      rememberOpenSet(input.threadId, {
        setId: input.setId,
        labels: suggestions.map((suggestion) => suggestion.label),
        prompts: suggestions.map((suggestion) => suggestion.prompt),
        filledIndex: null,
      });
      return { setId: input.setId, suggestions, skipped: null } satisfies UserInsightsSuggestResult;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("user-insights.suggest-error", { message: error.message }).pipe(
          Effect.as(skipped("failed")),
        ),
      ),
    );

  const suggest: UserInsights["Service"]["suggest"] = (threadId) => {
    /** The set this call is computing, if it started one. */
    let started: Deferred.Deferred<UserInsightsSuggestResult> | null = null;
    return Effect.gen(function* () {
      const current = yield* settings;
      if (!suggestionsOn(current) || Option.isNone(current)) return skipped("off");
      if (!current.value.providers.claudeAgent.enabled) return skipped("paused");
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (
        shell === null ||
        shell.latestRunId === null ||
        shell.activeRunId !== null ||
        shell.pendingRuntimeRequest !== null ||
        shell.lineage.relationshipToParent === "subagent"
      ) {
        return skipped("not-idle");
      }
      const runId = shell.latestRunId;
      const now = yield* Clock.currentTimeMillis;
      const gate = yield* locked(
        Effect.gen(function* () {
          const state = yield* loadState(now);
          const feedback = yield* store.readFeedback;
          return suggestGate({
            state,
            threadId,
            ready: isProfileReady(yield* loadProfile(now)),
            paused: pauseReason(state, { claudeAvailable: true }, now) !== null,
            acceptance: acceptanceLevel(feedback, state.acceptanceResetAt),
            now,
          });
        }),
      );
      if (gate !== null) return skipped(gate);

      const setId = `${threadId}:${runId}`;
      const existing = sets.get(setId);
      if (existing !== undefined) return yield* Deferred.await(existing);
      const deferred = Deferred.makeUnsafe<UserInsightsSuggestResult>();
      started = deferred;
      rememberSet(setId, deferred);

      const { messages } = yield* threads
        .getThreadRecords(threadId, ["messages"], { messageRunIds: [runId] })
        .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
      const assistantText = lastText(messages, "assistant");
      const result =
        assistantText === null
          ? skipped("not-idle")
          : yield* createSet({
              threadId,
              runId,
              setId,
              title: shell.title,
              userText: lastText(messages, "user"),
              assistantText,
            });
      yield* Deferred.succeed(deferred, result);
      return result;
    }).pipe(
      // A caller that went away or broke must not leave other windows
      // waiting on its set; the next ask for this turn starts over.
      Effect.onExit(() =>
        Effect.sync(() => {
          const deferred = started;
          if (deferred === null || Deferred.isDoneUnsafe(deferred)) return;
          for (const [setId, entry] of sets) if (entry === deferred) sets.delete(setId);
          Deferred.doneUnsafe(deferred, Effect.succeed(skipped("failed")));
        }),
      ),
    );
  };

  /** Suggestion feedback and mutes only count while insights are on. */
  const whenEnabled = (effect: Effect.Effect<void, UserInsightsError>) =>
    enabled.pipe(Effect.flatMap((on) => (on ? effect : Effect.void)));

  const act: UserInsights["Service"]["act"] = (action) => {
    switch (action.type) {
      case "import.preview":
        return previewImport.pipe(Effect.map((importPreview) => ({ importPreview })));
      case "import.start":
        return queueImport.pipe(Effect.andThen(forkImport), Effect.as({}));
      case "import.cancel":
        return cancelImport.pipe(Effect.as({}));
      default:
        return actOnProfile(action).pipe(Effect.as({}));
    }
  };

  const actOnProfile = (
    action: Exclude<
      UserInsightsAction,
      { readonly type: "import.preview" | "import.start" | "import.cancel" }
    >,
  ): Effect.Effect<void, UserInsightsError> => {
    switch (action.type) {
      case "suggestion.fill":
        return Effect.sync(() => {
          const open = openSets.get(action.threadId);
          if (open?.setId !== action.setId || action.index >= open.prompts.length) return;
          openSets.set(action.threadId, { ...open, filledIndex: action.index });
        });
      case "suggestion.dismiss":
        return whenEnabled(
          Effect.gen(function* () {
            const open = openSets.get(action.threadId);
            if (open?.setId !== action.setId) return;
            openSets.delete(action.threadId);
            // Other windows and remounts on this turn must not bring it back.
            const dismissed = Deferred.makeUnsafe<UserInsightsSuggestResult>();
            Deferred.doneUnsafe(dismissed, Effect.succeed(skipped("dismissed")));
            sets.set(open.setId, dismissed);
            const now = yield* Clock.currentTimeMillis;
            yield* locked(
              Effect.gen(function* () {
                yield* store.appendFeedback({
                  ts: toIso(now),
                  threadId: action.threadId,
                  setId: open.setId,
                  labels: open.labels,
                  outcome: "dismissed",
                });
                const state = yield* loadState(now);
                yield* store.writeState(recordOutcome(state, action.threadId, "dismissed", now));
              }),
            );
          }),
        );
      case "thread.mute":
        return whenEnabled(
          Effect.gen(function* () {
            openSets.delete(action.threadId);
            const now = yield* Clock.currentTimeMillis;
            yield* locked(
              loadState(now).pipe(
                Effect.flatMap((state) =>
                  store.writeState(muteThread(state, action.threadId, now)),
                ),
              ),
            );
          }),
        );
      case "trait.edit":
        return editTrait(action.id, action.value);
      case "trait.delete":
        return deleteTrait(action.id);
      case "profile.undo":
        return undo;
      case "data.reset":
        return locked(store.reset).pipe(Effect.andThen(forgetLearned));
      case "data.deleteAll":
        return locked(store.deleteAll).pipe(Effect.andThen(forgetLearned));
    }
  };

  return UserInsights.of({
    start,
    observe,
    tick,
    distillNow,
    snapshot,
    editTrait,
    deleteTrait,
    undo,
    reset: locked(store.reset).pipe(Effect.andThen(forgetLearned)),
    deleteAll: locked(store.deleteAll).pipe(Effect.andThen(forgetLearned)),
    suggest,
    act,
    queueImport,
    runImport,
  });
});

const importProgress = (cursor: ImportCursor | null | undefined) =>
  cursor === null || cursor === undefined
    ? null
    : { state: cursor.state, done: cursor.done, total: cursor.total };

/** Off is decided by the caller; this covers an enabled server. */
export function statusOf(input: {
  readonly profile: UserInsightsProfile;
  readonly state: UserInsightsState;
  readonly claudeAvailable: boolean;
  /** Suggestions are on but paused for low acceptance. */
  readonly lowAcceptance?: boolean;
  readonly now: number;
}): UserInsightsStatus {
  const reason = pauseReason(input.state, { claudeAvailable: input.claudeAvailable }, input.now);
  if (reason !== null) return { state: "paused", reason };
  if (input.lowAcceptance === true) return { state: "paused", reason: "low-acceptance" };
  if (isProfileReady(input.profile)) return { state: "ready" };
  return {
    state: "learning",
    samples: Math.min(input.profile.sampleCount, USER_INSIGHTS_READY_SAMPLES),
    requiredSamples: USER_INSIGHTS_READY_SAMPLES,
    pending: input.state.pendingEvidence,
  };
}

export const layer = Layer.effect(UserInsights, make);

export const startedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const insights = yield* UserInsights;
    yield* insights.start();
  }),
).pipe(Layer.provideMerge(layer));

/**
 * The RPC and MCP side reads the service optionally, so it does not join the
 * requirements of every server test that builds those layers.
 */
export const withService = <A>(
  use: (insights: UserInsights["Service"]) => Effect.Effect<A, UserInsightsError>,
) =>
  Effect.flatMap(Effect.serviceOption(UserInsights), (insights) =>
    Option.isSome(insights)
      ? use(insights.value)
      : Effect.fail(failure("This server does not keep user insights.")),
  );

export const readRpc = () => withService((insights) => insights.snapshot);

export const actRpc = (action: UserInsightsAction) =>
  withService((insights) => insights.act(action));

export const suggestRpc = (input: { readonly threadId: ThreadId }) =>
  withService((insights) => insights.suggest(input.threadId));
