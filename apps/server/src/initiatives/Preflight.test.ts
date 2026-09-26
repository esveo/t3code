import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeTestInitiatives, TEST_PROJECT, testShell } from "./testFakes.ts";

const ROBERT = "person:robert";
const THREAD = ThreadId.make("worker");

const makeHarness = Effect.gen(function* () {
  const harness = yield* makeTestInitiatives;
  const { initiatives, fake } = harness;
  fake.threads.set(
    "worker",
    testShell("worker", { runtimeMode: "auto", worktreePath: "/work/tree" }),
  );
  fake.threads.set("outsider", testShell("outsider"));
  const initiativeId = (yield* initiatives.act({ type: "create", title: "Relaunch" }, ROBERT)).id!;
  yield* initiatives.act({ type: "assignThread", initiativeId, threadId: THREAD }, ROBERT);
  return { ...harness, initiativeId };
});

const opened = (requestId: string, command: string, threadId = THREAD) => ({
  threadId,
  requestId,
  provider: "codex",
  createdAt: "2026-09-26T10:00:00.000Z",
  requestType: "command_execution_approval",
  args: { command },
  warnings: [],
});

describe("preflight in shadow mode", () => {
  it.effect("records the verdict and the user's click, and the click wins", () =>
    Effect.gen(function* () {
      const { initiatives, initiativeId } = yield* makeHarness;
      const observation = yield* initiatives.preflight.observeOpened(opened("r1", "rm -rf build"));
      assert.equal(observation?.verdicts[0]?.wouldHave, "ask");
      assert.equal(observation?.verdicts[0]?.category, "delete-data");
      assert.equal(observation?.runtimeMode, "auto");

      yield* initiatives.preflight.observeResolution({
        threadId: THREAD,
        requestId: "r1",
        by: "person",
        decision: "accept",
        at: "2026-09-26T10:01:00.000Z",
      });
      // The provider's resolution after the click does not replace it.
      yield* initiatives.preflight.observeResolution({
        threadId: THREAD,
        requestId: "r1",
        by: "provider-auto",
        decision: "accept",
        at: "2026-09-26T10:01:01.000Z",
      });
      yield* initiatives.preflight.observeOpened(opened("r2", "git status"));
      yield* initiatives.preflight.observeResolution({
        threadId: THREAD,
        requestId: "r2",
        by: "person",
        decision: "accept",
        at: "2026-09-26T10:02:00.000Z",
      });

      const report = yield* initiatives.preflight.report(initiativeId);
      assert.deepInclude(report.providers[0], {
        provider: "codex",
        requests: 2,
        byPerson: 2,
        inAutoMode: 2,
        agreed: 1,
        needlessAsks: 1,
      });
      const first = report.observations.find((entry) => entry.requestId === "r1")!;
      assert.equal(first.resolvedBy, "person");

      yield* initiatives.act(
        { type: "preflightMarkWrong", observationId: first.id, wrong: true },
        ROBERT,
      );
      assert.equal(
        (yield* initiatives.preflight.report(initiativeId)).providers[0]?.markedWrong,
        1,
      );
    }),
  );

  it.effect("looks only at threads of an initiative that has the preflight on", () =>
    Effect.gen(function* () {
      const { initiatives, initiativeId } = yield* makeHarness;
      assert.isNull(
        yield* initiatives.preflight.observeOpened(opened("r1", "ls", ThreadId.make("outsider"))),
      );
      yield* initiatives.act({ type: "setPreflightMode", initiativeId, mode: "off" }, ROBERT);
      assert.isNull(yield* initiatives.preflight.observeOpened(opened("r2", "ls")));
      // Questions to the user are no approvals.
      assert.isNull(
        yield* initiatives.preflight.observeOpened({
          ...opened("r3", "ls"),
          requestType: "tool_user_input",
        }),
      );
    }),
  );

  it.effect("stops every start while the global stop is on, and starts again after", () =>
    Effect.gen(function* () {
      const { initiatives, initiativeId, fake } = yield* makeHarness;
      const start = (key: string) => ({
        type: "startThread" as const,
        initiativeId,
        key,
        projectId: TEST_PROJECT,
        title: "Task",
        prompt: "Do it",
      });
      yield* initiatives.act({ type: "setHalt", initiativeId: null, halted: true }, ROBERT);
      assert.isTrue((yield* initiatives.listSnapshot).halted);
      const refused = yield* Effect.flip(initiatives.act(start("a"), ROBERT));
      assert.include(refused.message, "Not-Aus");
      yield* initiatives.act({ type: "setHalt", initiativeId: null, halted: false }, ROBERT);
      yield* initiatives.act(start("b"), ROBERT);
      assert.equal(fake.starts.length, 1);
    }),
  );
});
