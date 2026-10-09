import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { layerTest as settingsLayerTest, ServerSettingsService } from "../serverSettings.ts";
import {
  emptyUsage,
  type ModelUsage,
  UserInsightsModel,
  UserInsightsModelError,
} from "./HaikuCli.ts";
import { emptyState } from "./distillPolicy.ts";
import type { DistillOutput, SuggestOutput } from "./prompts.ts";
import { makeUserInsightsStore } from "./store.ts";
import * as UserInsights from "./UserInsights.ts";
import { toIso } from "./time.ts";
import { userMessageEvent } from "./userInsights.testkit.ts";

const NOW = Date.UTC(2026, 9, 8, 12);

type ModelAnswer = Effect.Effect<
  { readonly output: DistillOutput | SuggestOutput; readonly usage: ModelUsage },
  UserInsightsModelError
>;

const usage = (costUsd: number): ModelUsage => ({
  ...emptyUsage(1200),
  costUsd,
  costEstimated: false,
});

const answer = (ops: DistillOutput["ops"], costUsd = 0.01): ModelAnswer =>
  Effect.succeed({ output: { ops }, usage: usage(costUsd) });

const message = (index: number, text = `Bitte die Tests ${index} laufen lassen`) =>
  userMessageEvent({ id: `message-${index}` }, text);

interface Harness {
  readonly insights: UserInsights.UserInsights["Service"];
  readonly store: Effect.Success<ReturnType<typeof makeUserInsightsStore>>;
  readonly prompts: Ref.Ref<ReadonlyArray<string>>;
  readonly answers: Ref.Ref<ReadonlyArray<ModelAnswer>>;
  /** What the thread shell says; change `latestRunId` to start a new turn. */
  readonly shell: Ref.Ref<Record<string, unknown>>;
  readonly settings: ServerSettingsService["Service"];
  /** A fresh instance on the same folder, as after a server restart. */
  readonly restart: Effect.Effect<UserInsights.UserInsights["Service"]>;
}

const withInsights = <A, E>(
  options: {
    readonly enabled: boolean;
    readonly answers?: ReadonlyArray<ModelAnswer>;
    readonly events?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly suggestions?: boolean;
    readonly shell?: Record<string, unknown>;
    readonly messages?: ReadonlyArray<Record<string, unknown>>;
    /** Stored messages by thread id, for importing past messages. */
    readonly pastThreads?: Record<string, ReadonlyArray<Record<string, unknown>>>;
  },
  body: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const answers = yield* Ref.make<ReadonlyArray<ModelAnswer>>(options.answers ?? []);
    const model = Layer.succeed(
      UserInsightsModel,
      UserInsightsModel.of({
        run: (request) =>
          Effect.gen(function* () {
            yield* Ref.update(prompts, (all) => [...all, request.prompt]);
            const [next, ...rest] = yield* Ref.get(answers);
            yield* Ref.set(answers, rest);
            return yield* next ?? answer([]);
          }) as never,
      }),
    );
    const shell = yield* Ref.make<Record<string, unknown>>({
      projectId: "project-1",
      ...idleShell,
      ...options.shell,
    });
    const management = Layer.mock(ThreadManagementService)({
      getThreadShell: () => Ref.get(shell) as never,
      getThreadRecords: ((threadId: string) =>
        Effect.succeed({
          messages: options.pastThreads?.[threadId] ?? options.messages ?? lastExchange,
        })) as never,
      getShellSnapshot: (() =>
        Effect.succeed({
          threads: Object.keys(options.pastThreads ?? {}).map((id) => ({
            id,
            projectId: "project-1",
            lineage: { relationshipToParent: null },
            latestUserMessageAt: DateTime.makeUnsafe(NOW),
            updatedAt: DateTime.makeUnsafe(NOW),
          })),
          archivedThreads: [],
        })) as never,
      streamDomainEvents: options.events ?? Stream.empty,
    });
    const config = ServerConfig.layerTest(process.cwd(), { prefix: "user-insights-" });
    const dependencies = Layer.mergeAll(
      management,
      model,
      settingsLayerTest({
        enableUserInsights: options.enabled,
        enableUserInsightsSuggestions: options.suggestions ?? true,
      }),
      config,
    ).pipe(Layer.provideMerge(NodeServices.layer));
    return yield* Effect.gen(function* () {
      const insights = yield* UserInsights.UserInsights;
      const store = yield* makeUserInsightsStore((yield* ServerConfig).stateDir);
      const settings = yield* ServerSettingsService;
      const context = yield* Effect.context<Layer.Success<typeof dependencies>>();
      const restart = Effect.scoped(UserInsights.make).pipe(Effect.provideContext(context));
      return yield* body({ insights, store, prompts, answers, shell, settings, restart });
    }).pipe(Effect.provide(UserInsights.layer.pipe(Layer.provideMerge(dependencies))));
  });

const idleShell = {
  title: "Fix the login",
  latestRunId: "run-1",
  activeRunId: null,
  pendingRuntimeRequest: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
};

const lastExchange = [
  { role: "user", text: "Bitte den Login fixen", streaming: false },
  { role: "assistant", text: "Done, the login works again.", streaming: false },
];

const suggestAnswer = (
  suggestions: SuggestOutput["suggestions"] = [
    {
      label: "Tests laufen lassen",
      description: "Run the test suite.",
      prompt: "Lass die Tests laufen",
    },
    { label: "Committen", description: "Commit the fix.", prompt: "Bitte committen" },
  ],
): ModelAnswer => Effect.succeed({ output: { suggestions }, usage: usage(0.002) });

/** A profile that passes the readiness gate. */
const readyProfile = (now: number) => {
  const trait = (id: string) =>
    ({
      id,
      value: `value of ${id}`,
      support: 30,
      contradict: 0,
      confidence: 0.9,
      lastSeen: toIso(now),
      pinned: false,
      examples: [],
    }) as never;
  return {
    schemaVersion: 1 as const,
    updatedAt: toIso(now),
    sampleCount: 40,
    traits: ["style.language", "style.tone", "work.stack", "flow.followups"].map(trait),
  };
};

describe("UserInsights", () => {
  it.effect("does nothing while turned off", () =>
    withInsights({ enabled: false }, ({ insights, store, prompts }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (let index = 0; index < 12; index += 1) yield* insights.observe(message(index));
        assert.deepEqual(yield* insights.distillNow, { kind: "skipped", reason: "disabled" });
        assert.deepEqual(yield* insights.tick, { kind: "skipped", reason: "disabled" });
        assert.deepEqual((yield* insights.snapshot).status, { state: "off" });
        assert.isFalse(yield* fs.exists(store.directory));
        assert.strictEqual((yield* Ref.get(prompts)).length, 0);
      }),
    ),
  );

  it.effect("records each typed message once, and nothing else", () =>
    withInsights({ enabled: true }, ({ insights, store }) =>
      Effect.gen(function* () {
        yield* insights.observe(message(1));
        yield* insights.observe(message(1));
        yield* insights.observe(userMessageEvent({ id: "agent", createdBy: "agent" }));
        const evidence = yield* store.readEvidence;
        assert.strictEqual(evidence.length, 1);
        assert.strictEqual(evidence[0]?.projectId, "project-1");
        assert.strictEqual(evidence[0]?.messageId, "message-1");
        assert.strictEqual((yield* store.readState)?.pendingEvidence, 1);
      }),
    ),
  );

  it.effect("distills on the tick once a batch waited and the user paused", () =>
    withInsights(
      {
        enabled: true,
        answers: [
          answer([
            { traitId: "style.language", op: "add", value: "German", count: 3, evidence: [1, 2] },
            { traitId: "style.mood", op: "add", value: "happy", count: 1, evidence: [1] },
          ]),
        ],
      },
      ({ insights, store, prompts }) =>
        Effect.gen(function* () {
          for (let index = 0; index < 10; index += 1) yield* insights.observe(message(index));
          assert.deepEqual(yield* insights.tick, { kind: "skipped", reason: "waiting" });
          yield* TestClock.adjust("2 minutes");
          assert.deepEqual(yield* insights.tick, { kind: "distilled", applied: 1, rejected: 1 });
          const [prompt] = yield* Ref.get(prompts);
          assert.include(prompt, "1. [");
          assert.include(prompt, "Bitte die Tests 9 laufen lassen");
          const profile = yield* store.readProfile;
          assert.strictEqual(profile?.sampleCount, 10);
          assert.deepEqual(
            profile?.traits.map((trait) => [trait.id, trait.value]),
            [["style.language", "German"]],
          );
          // Excerpt 1 is the newest message.
          assert.deepEqual(profile?.traits[0]?.examples, ["message-9", "message-8"]);
          const ledger = yield* store.readUsage;
          assert.strictEqual(ledger.length, 1);
          assert.isTrue(ledger[0]?.ok);
          assert.strictEqual((yield* store.readState)?.pendingEvidence, 0);
          const snapshot = yield* insights.snapshot;
          assert.deepEqual(snapshot.status, {
            state: "learning",
            samples: 10,
            requiredSamples: 40,
            pending: 0,
          });
          assert.strictEqual(snapshot.usage.today.calls, 1);
        }),
    ),
  );

  it.effect("records a failed call and backs off, keeping the evidence", () =>
    withInsights(
      {
        enabled: true,
        answers: [
          Effect.fail(
            new UserInsightsModelError({ reason: "failed", message: "boom", usage: usage(0.002) }),
          ),
        ],
      },
      ({ insights, store, prompts }) =>
        Effect.gen(function* () {
          for (let index = 0; index < 3; index += 1) yield* insights.observe(message(index));
          assert.deepEqual(yield* insights.distillNow, { kind: "failed", message: "boom" });
          const ledger = yield* store.readUsage;
          assert.deepEqual(
            ledger.map((record) => [record.ok, record.error, record.costUsd]),
            [[false, "boom", 0.002]],
          );
          const state = yield* store.readState;
          assert.strictEqual(state?.pendingEvidence, 3);
          assert.strictEqual(state?.failures, 1);
          assert.deepEqual(yield* insights.distillNow, { kind: "skipped", reason: "backoff" });
          assert.deepEqual((yield* insights.snapshot).status, {
            state: "paused",
            reason: "backoff",
          });
          assert.strictEqual((yield* Ref.get(prompts)).length, 1);
        }),
    ),
  );

  it.effect("stops calling the model once today's cost cap is reached", () =>
    withInsights({ enabled: true, answers: [answer([], 1.2)] }, ({ insights, prompts }) =>
      Effect.gen(function* () {
        yield* insights.observe(message(1));
        assert.strictEqual((yield* insights.distillNow).kind, "distilled");
        yield* insights.observe(message(2));
        assert.deepEqual(yield* insights.distillNow, { kind: "skipped", reason: "budget" });
        assert.deepEqual((yield* insights.snapshot).status, { state: "paused", reason: "budget" });
        assert.strictEqual((yield* Ref.get(prompts)).length, 1);
      }),
    ),
  );

  it.effect("edits pin a trait, and undo, reset and deleteAll take it back", () =>
    withInsights({ enabled: true }, ({ insights, store }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* insights.editTrait("style.tone", "Direct");
        yield* insights.editTrait("style.length", "Short");
        assert.deepEqual(
          (yield* insights.snapshot).traits.map((trait) => [trait.id, trait.pinned]),
          [
            ["style.length", true],
            ["style.tone", true],
          ],
        );
        yield* insights.undo;
        assert.deepEqual(
          (yield* insights.snapshot).traits.map((trait) => trait.id),
          ["style.tone"],
        );
        yield* insights.deleteTrait("style.tone");
        assert.deepEqual((yield* insights.snapshot).traits, []);
        yield* insights.reset;
        assert.isNull(yield* store.readProfile);
        yield* insights.deleteAll;
        assert.isFalse(yield* fs.exists(store.directory));
      }),
    ),
  );

  it.effect("follows the live domain events once started", () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const events = Stream.make(message(1), message(2)).pipe(
        Stream.ensuring(Deferred.succeed(done, undefined)),
      );
      yield* withInsights({ enabled: true, events }, ({ insights, store }) =>
        Effect.gen(function* () {
          yield* insights.start();
          yield* Deferred.await(done);
          assert.strictEqual((yield* store.readEvidence).length, 2);
        }).pipe(Effect.scoped),
      );
    }),
  );

  it.effect("suggests once the profile is ready, once per turn", () =>
    withInsights({ enabled: true, answers: [suggestAnswer()] }, ({ insights, store, prompts }) =>
      Effect.gen(function* () {
        const threadId = "thread-1" as never;
        assert.deepEqual(yield* insights.suggest(threadId), {
          setId: null,
          suggestions: [],
          skipped: "not-ready",
        });
        yield* store.writeProfile(readyProfile(NOW));
        const [first, second] = yield* Effect.all(
          [insights.suggest(threadId), insights.suggest(threadId)],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(first.setId, "thread-1:run-1");
        assert.deepEqual(
          first.suggestions.map((suggestion) => suggestion.prompt),
          ["Lass die Tests laufen", "Bitte committen"],
        );
        assert.deepEqual(second, first);
        const sent = yield* Ref.get(prompts);
        assert.strictEqual(sent.length, 1);
        assert.include(sent[0], "Done, the login works again.");
        assert.include(sent[0], "flow.followups: value of flow.followups");
        const ledger = yield* store.readUsage;
        assert.deepEqual(
          ledger.map((record) => [record.purpose, record.ok]),
          [["suggest", true]],
        );
        assert.strictEqual((yield* store.readState)?.suggestsToday, 1);
      }),
    ),
  );

  it.effect("asks nothing while suggestions are off or the thread is busy", () =>
    Effect.gen(function* () {
      yield* withInsights({ enabled: true, suggestions: false }, ({ insights, prompts }) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* insights.suggest("thread-1" as never)).skipped, "off");
          assert.strictEqual((yield* Ref.get(prompts)).length, 0);
        }),
      );
      yield* withInsights(
        { enabled: true, shell: { activeRunId: "run-2" } },
        ({ insights, store }) =>
          Effect.gen(function* () {
            yield* store.writeProfile(readyProfile(NOW));
            assert.strictEqual((yield* insights.suggest("thread-1" as never)).skipped, "not-idle");
          }),
      );
      yield* withInsights(
        {
          enabled: true,
          shell: {
            lineage: { parentThreadId: "p", relationshipToParent: "subagent", rootThreadId: "p" },
          },
        },
        ({ insights, store }) =>
          Effect.gen(function* () {
            yield* store.writeProfile(readyProfile(NOW));
            assert.strictEqual((yield* insights.suggest("thread-1" as never)).skipped, "not-idle");
          }),
      );
    }),
  );

  it.effect("learns from what the user does with a set", () =>
    withInsights({ enabled: true, answers: [suggestAnswer()] }, ({ insights, store }) =>
      Effect.gen(function* () {
        const threadId = "thread-1" as never;
        yield* store.writeProfile(readyProfile(NOW));
        const set = yield* insights.suggest(threadId);
        assert.isNotNull(set.setId);
        yield* insights.act({
          type: "suggestion.fill",
          threadId,
          setId: set.setId as never,
          index: 1,
        });
        yield* insights.observe(userMessageEvent({ id: "after-1" }, "Bitte committen"));
        // A later message has no open set left to judge.
        yield* insights.observe(userMessageEvent({ id: "after-2" }, "Und pushen"));
        const feedback = yield* store.readFeedback;
        assert.deepEqual(
          feedback.map((record) => [record.outcome, record.index]),
          [["accepted", 1]],
        );
      }),
    ),
  );

  it.effect("cools a thread down after two missed sets, and mutes on request", () =>
    withInsights(
      { enabled: true, answers: [suggestAnswer(), suggestAnswer(), suggestAnswer()] },
      ({ insights, store, prompts, shell }) =>
        Effect.gen(function* () {
          const threadId = "thread-1" as never;
          const nextTurn = (runId: string) =>
            Ref.update(shell, (current) => ({ ...current, latestRunId: runId }));
          yield* store.writeProfile(readyProfile(NOW));
          const first = yield* insights.suggest(threadId);
          yield* insights.act({
            type: "suggestion.dismiss",
            threadId,
            setId: first.setId as never,
          });
          // Another window on the same turn does not bring it back.
          assert.strictEqual((yield* insights.suggest(threadId)).skipped, "dismissed");
          yield* insights.observe(userMessageEvent({ id: "after-1" }, "Etwas anderes"));
          yield* nextTurn("run-2");
          assert.strictEqual((yield* insights.suggest(threadId)).skipped, null);
          yield* insights.observe(userMessageEvent({ id: "after-2" }, "Noch etwas"));
          assert.deepEqual(
            (yield* store.readFeedback).map((record) => record.outcome),
            ["dismissed", "ignored"],
          );
          yield* nextTurn("run-3");
          assert.strictEqual((yield* insights.suggest(threadId)).skipped, "cooldown");
          yield* TestClock.adjust("31 minutes");
          yield* insights.act({ type: "thread.mute", threadId });
          assert.strictEqual((yield* insights.suggest(threadId)).skipped, "muted");
          assert.strictEqual((yield* Ref.get(prompts)).length, 2);
        }),
    ),
  );

  it.effect("records a failed suggest call without retrying it for the same turn", () =>
    withInsights(
      {
        enabled: true,
        answers: [
          Effect.fail(
            new UserInsightsModelError({ reason: "failed", message: "boom", usage: usage(0.001) }),
          ),
        ],
      },
      ({ insights, store, prompts }) =>
        Effect.gen(function* () {
          yield* store.writeProfile(readyProfile(NOW));
          assert.strictEqual((yield* insights.suggest("thread-1" as never)).skipped, "failed");
          assert.strictEqual((yield* insights.suggest("thread-1" as never)).skipped, "failed");
          assert.strictEqual((yield* Ref.get(prompts)).length, 1);
          assert.deepEqual(
            (yield* store.readUsage).map((record) => [record.purpose, record.ok, record.error]),
            [["suggest", false, "boom"]],
          );
        }),
    ),
  );

  it.effect("passes suggestion feedback to the next distill", () =>
    withInsights({ enabled: true, answers: [suggestAnswer()] }, ({ insights, store, prompts }) =>
      Effect.gen(function* () {
        const threadId = "thread-1" as never;
        yield* store.writeProfile(readyProfile(NOW));
        const set = yield* insights.suggest(threadId);
        yield* insights.act({
          type: "suggestion.fill",
          threadId,
          setId: set.setId as never,
          index: 0,
        });
        yield* insights.observe(
          userMessageEvent({ id: "after-1" }, "Lass die Tests laufen, bitte"),
        );
        yield* insights.distillNow;
        const distillPrompt = (yield* Ref.get(prompts))[1];
        assert.include(distillPrompt, 'edited: "Tests laufen lassen"');
      }),
    ),
  );

  it.effect("keeps a value the user edited when a distill tries to revise it", () =>
    withInsights(
      {
        enabled: true,
        answers: [
          answer([
            { traitId: "style.tone", op: "revise", value: "Polite", count: 5, evidence: [1] },
            { traitId: "style.tone", op: "contradict", value: null, count: 5, evidence: [1] },
          ]),
        ],
      },
      ({ insights }) =>
        Effect.gen(function* () {
          yield* insights.act({ type: "trait.edit", id: "style.tone", value: "  Direct  " });
          yield* insights.observe(message(1));
          assert.strictEqual((yield* insights.distillNow).kind, "distilled");
          const [tone] = (yield* insights.snapshot).traits;
          assert.strictEqual(tone?.value, "Direct");
          assert.isTrue(tone?.pinned);
          assert.isAbove(tone?.contradict ?? 0, 0);
          const error = yield* insights
            .act({ type: "trait.edit", id: "style.tone", value: "x".repeat(161) })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "UserInsightsError");
        }),
    ),
  );

  it.effect("reset forgets the profile but keeps usage; delete everything removes all", () =>
    withInsights({ enabled: true, answers: [answer([], 0.02)] }, ({ insights, store }) =>
      Effect.gen(function* () {
        yield* insights.observe(message(1));
        yield* insights.distillNow;
        yield* insights.act({ type: "trait.edit", id: "style.tone", value: "Direct" });
        yield* insights.act({ type: "data.reset" });
        const afterReset = yield* insights.snapshot;
        assert.deepEqual(afterReset.traits, []);
        assert.deepEqual(afterReset.status, {
          state: "learning",
          samples: 0,
          requiredSamples: 40,
          pending: 0,
        });
        assert.strictEqual(afterReset.usage.total.calls, 1);
        assert.isTrue(afterReset.hasStoredData);
        assert.strictEqual((yield* store.readEvidence).length, 0);
        const undo = yield* insights.act({ type: "profile.undo" }).pipe(Effect.flip);
        assert.strictEqual(undo._tag, "UserInsightsError");

        yield* insights.act({ type: "data.deleteAll" });
        const afterDelete = yield* insights.snapshot;
        assert.strictEqual(afterDelete.usage.total.calls, 0);
        assert.isFalse(afterDelete.hasStoredData);
      }),
    ),
  );

  it.effect("writes nothing when insights were turned off during a distill", () =>
    withInsights({ enabled: true }, ({ insights, store, answers, settings }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* insights.observe(message(1));
        yield* Ref.set(answers, [
          Effect.gen(function* () {
            yield* settings.updateSettings({ enableUserInsights: false });
            yield* store.deleteAll;
            return yield* answer([
              { traitId: "style.tone", op: "add", value: "Direct", count: 1, evidence: [1] },
            ]);
          }).pipe(Effect.orDie),
        ]);
        assert.deepEqual(yield* insights.distillNow, { kind: "skipped", reason: "disabled" });
        assert.isFalse(yield* fs.exists(store.directory));
      }),
    ),
  );

  it.effect("a reset during a distill keeps the ledger but drops the result", () =>
    withInsights({ enabled: true }, ({ insights, store, answers }) =>
      Effect.gen(function* () {
        yield* insights.observe(message(1));
        yield* Ref.set(answers, [
          insights.reset.pipe(
            Effect.orDie,
            Effect.andThen(
              answer(
                [{ traitId: "style.tone", op: "add", value: "Direct", count: 1, evidence: [1] }],
                0.01,
              ),
            ),
          ),
        ]);
        assert.deepEqual(yield* insights.distillNow, { kind: "skipped", reason: "reset" });
        assert.isNull(yield* store.readProfile);
        assert.strictEqual((yield* store.readUsage).length, 1);
        assert.strictEqual((yield* store.readState)?.costTodayUsd, 0.01);
        assert.strictEqual((yield* store.readState)?.pendingEvidence, 0);
      }),
    ),
  );

  it.effect("a set finished after the user wrote on is not held against them", () =>
    withInsights({ enabled: true }, ({ insights, store, answers, shell }) =>
      Effect.gen(function* () {
        const threadId = "thread-1" as never;
        yield* store.writeProfile(readyProfile(NOW));
        yield* Ref.set(answers, [
          Ref.update(shell, (current) => ({ ...current, latestRunId: "run-2" })).pipe(
            Effect.andThen(suggestAnswer()),
          ),
        ]);
        assert.strictEqual((yield* insights.suggest(threadId)).skipped, "not-idle");
        yield* insights.observe(userMessageEvent({ id: "after-1" }, "Weiter"));
        assert.deepEqual(yield* store.readFeedback, []);
        assert.strictEqual((yield* store.readUsage).length, 1);
      }),
    ),
  );

  it.effect("trims the evidence while no distill gets through", () =>
    withInsights({ enabled: true }, ({ insights, store }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 600; index += 1) {
          yield* store.appendEvidence({
            ts: toIso(NOW),
            threadId: "thread-1",
            projectId: null,
            messageId: `old-${index}`,
            chars: 5,
            words: 1,
            lang: "de",
            hasCode: false,
            hasPath: false,
            endsWithQuestion: false,
          });
        }
        yield* store.writeState({ ...emptyState(NOW), pendingEvidence: 499 });
        yield* insights.observe(message(1));
        assert.strictEqual((yield* store.readEvidence).length, 500);
      }),
    ),
  );

  it.effect("shows stored data while off, so it can still be deleted", () =>
    withInsights({ enabled: false }, ({ insights, store }) =>
      Effect.gen(function* () {
        assert.isFalse((yield* insights.snapshot).hasStoredData);
        yield* store.writeState(emptyState(NOW));
        assert.isTrue((yield* insights.snapshot).hasStoredData);
        yield* insights.act({ type: "data.deleteAll" });
        assert.isFalse((yield* insights.snapshot).hasStoredData);
      }),
    ),
  );
});

describe("summarizeUsage", () => {
  const record = (ts: string, costUsd: number) => ({
    ts,
    purpose: "distill" as const,
    model: "claude-haiku-4-5",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 1000,
    cacheCreationTokens: 10,
    costUsd,
    costEstimated: false,
    durationMs: 1,
    ok: true,
  });

  it("splits today, the last seven days and the whole ledger, counting cache tokens as input", () => {
    const summary = UserInsights.summarizeUsage(
      [
        record("2026-09-01T12:00:00.000Z", 0.1),
        record("2026-10-03T12:00:00.000Z", 0.02),
        record("2026-10-08T08:00:00.000Z", 0.01),
      ],
      { now: NOW, lastDistillAt: null },
    );
    assert.deepEqual(summary.today, {
      calls: 1,
      inputTokens: 1110,
      outputTokens: 20,
      costUsd: 0.01,
    });
    assert.strictEqual(summary.last7Days.calls, 2);
    assert.strictEqual(summary.total.calls, 3);
    assert.closeTo(summary.total.costUsd, 0.13, 1e-9);
  });
});

/** A stored message `minutesAgo` before NOW; a user message typed on web unless overridden. */
const pastMessage = (id: string, minutesAgo: number, overrides: Record<string, unknown> = {}) => {
  const at = DateTime.makeUnsafe(NOW - minutesAgo * 60_000);
  return {
    id,
    threadId: "past-thread",
    runId: null,
    nodeId: null,
    role: "user",
    createdBy: "user",
    creationSource: "web",
    text: `Bitte ${id} erledigen`,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
};

/** `count` exchanges of an agent reply and the user's answer, `daysAgo` old. */
const pastExchanges = (prefix: string, count: number, daysAgo: number) =>
  Array.from({ length: count }, (_, index) => {
    const minutesAgo = daysAgo * 24 * 60 + (count - index) * 2;
    return [
      pastMessage(`${prefix}-reply-${index}`, minutesAgo + 1, {
        role: "assistant",
        createdBy: "agent",
        creationSource: "provider",
        text: "Fertig. Soll ich die Tests laufen lassen?",
      }),
      pastMessage(`${prefix}-${index}`, minutesAgo),
    ];
  }).flat();

const toneAdd = (costUsd = 0.01) =>
  answer([{ traitId: "style.tone", op: "add", value: "Direct", count: 3, evidence: [1] }], costUsd);

describe("UserInsights import of past messages", () => {
  it.effect("learns in batches of 30, the older batch weighing less", () =>
    withInsights(
      {
        enabled: true,
        pastThreads: {
          "past-thread": [
            ...pastExchanges("old", 30, 20),
            ...pastExchanges("new", 15, 1),
            pastMessage("agent", 5, { createdBy: "agent" }),
            pastMessage("scheduled", 4, { scheduledTaskId: "task-1" }),
            pastMessage("slash", 3, { text: "/compact" }),
            pastMessage("message-1", 2),
          ],
        },
      },
      ({ insights, store, prompts, answers }) =>
        Effect.gen(function* () {
          // Already observed live, so the import skips it.
          yield* insights.observe(message(1));
          const preview = yield* insights.act({ type: "import.preview" });
          assert.deepEqual(preview.importPreview, {
            messages: 45,
            batches: 2,
            estimatedCostUsd: 0.06,
          });
          yield* Ref.set(answers, [
            // A second runner started meanwhile does nothing.
            insights.runImport.pipe(
              Effect.tap((nested) => Effect.sync(() => assert.strictEqual(nested, 0))),
              Effect.andThen(toneAdd()),
            ),
            answer([]),
          ]);
          yield* insights.queueImport;
          assert.strictEqual(yield* insights.runImport, 2);

          const sent = yield* Ref.get(prompts);
          assert.strictEqual(sent.length, 2);
          assert.include(sent[0], "answering the agent's reply ending");
          assert.include(sent[0], "old-29");
          assert.notInclude(sent[0], "new-0");
          const tone = (yield* store.readProfile)?.traits.find((t) => t.id === "style.tone");
          assert.closeTo(tone?.support ?? 0, 3 * 0.5 ** (20 / 30), 0.01);
          assert.strictEqual((yield* store.readProfile)?.sampleCount, 45);

          const evidence = yield* store.readEvidence;
          assert.strictEqual(evidence.length, 46);
          // The live message stays last, pending for the next distill.
          assert.strictEqual(evidence.at(-1)?.messageId, "message-1");
          const state = yield* store.readState;
          assert.strictEqual(state?.pendingEvidence, 1);
          assert.strictEqual(state?.distillsToday, 0);
          assert.closeTo(state?.costTodayUsd ?? 0, 0.02, 1e-9);
          assert.deepEqual(
            (yield* store.readUsage).map((record) => record.purpose),
            ["import", "import"],
          );
          assert.deepEqual((yield* insights.snapshot).import, {
            state: "done",
            done: 45,
            total: 45,
          });
          // Everything is known now.
          const again = yield* insights.act({ type: "import.preview" });
          assert.strictEqual(again.importPreview?.messages, 0);
        }),
    ),
  );

  it.effect("retries a failed batch once before it backs off", () => {
    const boom = () =>
      Effect.fail(
        new UserInsightsModelError({ reason: "failed", message: "boom", usage: usage(0.001) }),
      );
    return withInsights(
      {
        enabled: true,
        pastThreads: { "past-thread": pastExchanges("past", 40, 2) },
        // First batch fails once and then learns; the second fails twice.
        answers: [boom(), toneAdd(), boom(), boom()],
      },
      ({ insights, store }) =>
        Effect.gen(function* () {
          yield* insights.queueImport;
          assert.strictEqual(yield* insights.runImport, 1);
          assert.deepEqual((yield* insights.snapshot).import, {
            state: "running",
            done: 30,
            total: 40,
          });
          const state = yield* store.readState;
          assert.strictEqual(state?.failures, 1);
          assert.isNotNull(state?.backoffUntil);
          assert.deepEqual(
            (yield* store.readUsage).map((record) => record.ok),
            [false, true, false, false],
          );
        }),
    );
  });

  it.effect("waits at the daily cost cap and resumes the next day, also after a restart", () =>
    withInsights(
      {
        enabled: true,
        pastThreads: { "past-thread": pastExchanges("past", 70, 2) },
        answers: [toneAdd(0.6), answer([], 0.6), answer([], 0.01)],
      },
      ({ insights, store, prompts, restart }) =>
        Effect.gen(function* () {
          yield* insights.queueImport;
          assert.strictEqual(yield* insights.runImport, 2);
          assert.deepEqual((yield* insights.snapshot).import, {
            state: "running",
            done: 60,
            total: 70,
          });
          const failedAgain = yield* insights.queueImport.pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "started" }),
          );
          assert.strictEqual(failedAgain, "An import is already running.");

          const restarted = yield* restart;
          assert.strictEqual(yield* restarted.runImport, 0);
          yield* TestClock.adjust("1 day");
          assert.strictEqual(yield* restarted.runImport, 1);
          assert.strictEqual((yield* Ref.get(prompts)).length, 3);
          assert.deepEqual((yield* insights.snapshot).import, {
            state: "done",
            done: 70,
            total: 70,
          });
          assert.isFalse(
            yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.exists(store.files.importQueue)),
            ),
          );
        }),
    ),
  );

  it.effect("cancel, reset and delete during a batch leave no learned trace", () =>
    withInsights(
      { enabled: true, pastThreads: { "past-thread": pastExchanges("past", 40, 1) } },
      ({ insights, store, answers, settings }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          yield* Ref.set(answers, [
            insights.act({ type: "import.cancel" }).pipe(Effect.orDie, Effect.andThen(toneAdd())),
          ]);
          yield* insights.queueImport;
          assert.strictEqual(yield* insights.runImport, 0);
          assert.isNull(yield* store.readProfile);
          assert.strictEqual((yield* store.readEvidence).length, 0);
          assert.deepEqual((yield* insights.snapshot).import, {
            state: "cancelled",
            done: 0,
            total: 40,
          });
          assert.strictEqual((yield* store.readUsage).length, 1);

          yield* Ref.set(answers, [insights.reset.pipe(Effect.orDie, Effect.andThen(toneAdd()))]);
          yield* insights.queueImport;
          assert.strictEqual(yield* insights.runImport, 0);
          assert.isNull(yield* store.readProfile);
          assert.isNull((yield* insights.snapshot).import ?? null);
          assert.isFalse(yield* fs.exists(store.files.importQueue));

          yield* Ref.set(answers, [
            Effect.gen(function* () {
              yield* settings.updateSettings({ enableUserInsights: false });
              yield* store.deleteAll;
              return yield* toneAdd();
            }).pipe(Effect.orDie),
          ]);
          yield* insights.queueImport;
          assert.strictEqual(yield* insights.runImport, 0);
          assert.isFalse(yield* fs.exists(store.directory));
        }),
    ),
  );
});
