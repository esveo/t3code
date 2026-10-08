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
 */
import {
  USER_INSIGHTS_DAILY_COST_CAP_USD,
  USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH,
  USER_INSIGHTS_READY_SAMPLES,
  USER_INSIGHTS_TRAIT_IDS,
  type OrchestrationV2DomainEvent,
  UserInsightsError,
  type UserInsightsProfile,
  type UserInsightsSnapshot,
  type UserInsightsStatus,
  type UserInsightsTraitId,
  type UserInsightsUsageSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
  applyOps,
  deleteTrait as deleteProfileTrait,
  editTrait as editProfileTrait,
  emptyProfile,
  isProfileReady,
  validateOps,
} from "./profileMerge.ts";
import { buildDistillPrompt, DistillOutput, selectDistillEvidence } from "./prompts.ts";
import { makeUserInsightsStore, type UsageRecord } from "./store.ts";
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
  }
>()("t3/userInsights/UserInsights") {}

const TICK_INTERVAL = "1 minute";

const traitOrder = (id: string) => (USER_INSIGHTS_TRAIT_IDS as ReadonlyArray<string>).indexOf(id);

const sumUsage = (records: ReadonlyArray<UsageRecord>) => ({
  calls: records.length,
  costUsd: records.reduce((total, record) => total + record.costUsd, 0),
});

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
  };
}

const failure = (message: string) => new UserInsightsError({ message });

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const settingsService = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const model = yield* UserInsightsModel;
  const store = yield* makeUserInsightsStore(config.stateDir);
  const io = yield* Semaphore.make(1);
  const distilling = yield* Semaphore.make(1);
  const isNew = makeSeenIds();

  const settings = settingsService.getSettings.pipe(Effect.option);
  const enabled = settings.pipe(
    Effect.map((value) => Option.isSome(value) && value.value.enableUserInsights),
  );
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
      yield* locked(
        Effect.gen(function* () {
          yield* store.appendEvidence(record);
          const state = yield* loadState(now);
          yield* store.writeState({
            ...state,
            pendingEvidence: state.pendingEvidence + 1,
            lastMessageAt: toIso(now),
          });
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("user-insights.observe-failed", { cause })),
    );

  const usageRecord = (input: {
    readonly now: number;
    readonly usage: ModelUsage;
    readonly ok: boolean;
    readonly error?: string;
  }): UsageRecord => ({
    ts: toIso(input.now),
    purpose: "distill",
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
                yield* store.writeState({ ...state, pendingEvidence: 0 });
                return { kind: "skip", reason: "no-evidence" } as const;
              }
              const profile = yield* loadProfile(startedAt);
              return {
                kind: "run",
                consumed: state.pendingEvidence,
                selected,
                prompt: buildDistillPrompt({ profile, evidence: selected }),
              } as const;
            }),
          );
          if (prepared.kind === "skip")
            return { kind: "skipped", reason: prepared.reason } as const;

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
              let state = recordCall(yield* loadState(endedAt), {
                purpose: "distill",
                costUsd: usage.costUsd,
              });
              if (!outcome.ok) {
                yield* store.appendUsage(
                  usageRecord({ now: endedAt, usage, ok: false, error: outcome.error.message }),
                );
                yield* store.writeState(recordFailure(state, endedAt));
                yield* Effect.logWarning("user-insights.distill-failed", {
                  message: outcome.error.message,
                });
                return { kind: "failed", message: outcome.error.message } as const;
              }
              yield* store.appendUsage(usageRecord({ now: endedAt, usage, ok: true }));
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

  const snapshot: UserInsights["Service"]["snapshot"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* settings;
    if (Option.isNone(current) || !current.value.enableUserInsights) {
      return {
        status: { state: "off" },
        traits: [],
        usage: summarizeUsage([], { now, lastDistillAt: null }),
        folderPath: store.directory,
      } satisfies UserInsightsSnapshot;
    }
    const { profile, state, usage } = yield* locked(
      Effect.all({
        profile: loadProfile(now),
        state: loadState(now),
        usage: store.readUsage,
      }),
    );
    return {
      status: statusOf({
        profile,
        state,
        claudeAvailable: current.value.providers.claudeAgent.enabled,
        now,
      }),
      traits: [...profile.traits].toSorted((a, b) => traitOrder(a.id) - traitOrder(b.id)),
      usage: summarizeUsage(usage, { now, lastDistillAt: state.lastDistillAt }),
      folderPath: store.directory,
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
        yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)));
      }),
    );

  return UserInsights.of({
    start,
    observe,
    tick,
    distillNow,
    snapshot,
    editTrait,
    deleteTrait,
    undo,
    reset: locked(store.reset),
    deleteAll: locked(store.deleteAll),
  });
});

/** Off is decided by the caller; this covers an enabled server. */
export function statusOf(input: {
  readonly profile: UserInsightsProfile;
  readonly state: UserInsightsState;
  readonly claudeAvailable: boolean;
  readonly now: number;
}): UserInsightsStatus {
  const reason = pauseReason(input.state, { claudeAvailable: input.claudeAvailable }, input.now);
  if (reason !== null) return { state: "paused", reason };
  if (isProfileReady(input.profile)) return { state: "ready" };
  return {
    state: "learning",
    samples: Math.min(input.profile.sampleCount, USER_INSIGHTS_READY_SAMPLES),
    requiredSamples: USER_INSIGHTS_READY_SAMPLES,
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
