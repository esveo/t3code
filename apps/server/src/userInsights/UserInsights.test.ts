import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { layerTest as settingsLayerTest } from "../serverSettings.ts";
import {
  emptyUsage,
  type ModelUsage,
  UserInsightsModel,
  UserInsightsModelError,
} from "./HaikuCli.ts";
import type { DistillOutput } from "./prompts.ts";
import { makeUserInsightsStore } from "./store.ts";
import * as UserInsights from "./UserInsights.ts";
import { userMessageEvent } from "./userInsights.testkit.ts";

const NOW = Date.UTC(2026, 9, 8, 12);

type ModelAnswer = Effect.Effect<
  { readonly output: DistillOutput; readonly usage: ModelUsage },
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
}

const withInsights = <A, E>(
  options: {
    readonly enabled: boolean;
    readonly answers?: ReadonlyArray<ModelAnswer>;
    readonly events?: Stream.Stream<OrchestrationV2DomainEvent>;
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
    const management = Layer.mock(ThreadManagementService)({
      getThreadShell: () => Effect.succeed({ projectId: "project-1" } as never),
      streamDomainEvents: options.events ?? Stream.empty,
    });
    const config = ServerConfig.layerTest(process.cwd(), { prefix: "user-insights-" });
    const dependencies = Layer.mergeAll(
      management,
      model,
      settingsLayerTest({ enableUserInsights: options.enabled }),
      config,
    ).pipe(Layer.provideMerge(NodeServices.layer));
    return yield* Effect.gen(function* () {
      const insights = yield* UserInsights.UserInsights;
      const store = yield* makeUserInsightsStore((yield* ServerConfig).stateDir);
      return yield* body({ insights, store, prompts, answers });
    }).pipe(Effect.provide(UserInsights.layer.pipe(Layer.provideMerge(dependencies))));
  });

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
    withInsights({ enabled: true, answers: [answer([], 0.6)] }, ({ insights, prompts }) =>
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
});
