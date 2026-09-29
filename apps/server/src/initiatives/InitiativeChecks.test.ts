import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { Escalate } from "./InitiativeChecks.ts";
import { makeTestInitiatives, testShell } from "./testFakes.ts";

const ROBERT = "person:robert";
const COORDINATOR = "role:coordinator:coordinator";
const WORKER = ThreadId.make("worker");

const makeHarness = Effect.gen(function* () {
  const harness = yield* makeTestInitiatives;
  harness.fake.threads.set("worker", testShell("worker"));
  const initiativeId = (yield* harness.initiatives.act(
    { type: "create", title: "Relaunch" },
    ROBERT,
  )).id!;
  const task = yield* harness.initiatives.entries.create(
    {
      initiativeId,
      type: "task",
      title: "Contact form",
      acceptanceCheck: {
        kind: "command",
        description: "The form's tests pass",
        ref: "vp test run contact",
        expected: "0 failed",
      },
    },
    COORDINATOR,
  );
  const escalations: Array<string> = [];
  const escalate: Escalate = ({ question }) => Effect.sync(() => void escalations.push(question));
  return { ...harness, initiativeId, task, escalations, escalate };
});

describe("initiative checks", () => {
  it.effect("keeps a task from done until its check passed, with evidence", () =>
    Effect.gen(function* () {
      const { initiatives, task } = yield* makeHarness;
      const early = yield* Effect.flip(initiatives.entries.setStatus(task.id, "done", COORDINATOR));
      assert.include(early.message, "not been reported");

      const bare = yield* Effect.flip(
        initiatives.checks.report(task.id, { outcome: "passed" }, COORDINATOR),
      );
      assert.include(bare.message, "evidence");
      // A command check passes only with the output that shows it.
      const linkOnly = yield* Effect.flip(
        initiatives.checks.report(task.id, { outcome: "passed", url: "https://ci/1" }, COORDINATOR),
      );
      assert.include(linkOnly.message, "output excerpt");

      yield* initiatives.checks.report(
        task.id,
        { outcome: "failed", excerpt: "2 failed" },
        COORDINATOR,
      );
      const failed = yield* Effect.flip(
        initiatives.entries.setStatus(task.id, "done", COORDINATOR),
      );
      assert.include(failed.message, "failed last");

      yield* initiatives.checks.report(
        task.id,
        { outcome: "passed", excerpt: "12 passed, 0 failed" },
        COORDINATOR,
      );
      const done = yield* initiatives.entries.setStatus(task.id, "done", COORDINATOR);
      assert.equal(done.status, "done");
      assert.equal(done.checkResults?.length, 2);
    }),
  );

  it.effect("lets only a person accept a task without a check, and marks it", () =>
    Effect.gen(function* () {
      const { initiatives, initiativeId } = yield* makeHarness;
      const unchecked = yield* initiatives.entries.create(
        { initiativeId, type: "task", title: "Write the copy" },
        COORDINATOR,
      );
      const refused = yield* Effect.flip(
        initiatives.entries.setStatus(unchecked.id, "done", ROBERT),
      );
      assert.include(refused.message, "no acceptance check");
      const agent = yield* Effect.flip(
        initiatives.checks.acceptWithoutCheck(unchecked.id, COORDINATOR),
      );
      assert.include(agent.message, "Only the user");

      yield* initiatives.act({ type: "entryAcceptWithoutCheck", entryId: unchecked.id }, ROBERT);
      const accepted = yield* initiatives.entries.requireEntry(unchecked.id);
      assert.equal(accepted.status, "done");
      assert.equal(accepted.acceptedWithoutCheckBy, ROBERT);
    }),
  );

  it.effect("returns a task alone to its thread, and escalates after three corrections", () =>
    Effect.gen(function* () {
      const { initiatives, fake, task, escalate, escalations } = yield* makeHarness;
      const unassigned = yield* Effect.flip(
        initiatives.checks.returnUnit(
          task.id,
          { finding: "Spam gets through", scope: "Add the honeypot field" },
          COORDINATOR,
          escalate,
        ),
      );
      assert.include(unassigned.message, "names no thread");

      yield* initiatives.checks.assignThread(task.id, WORKER, COORDINATOR);
      for (const attempt of [1, 2, 3]) {
        const outcome = yield* initiatives.checks.returnUnit(
          task.id,
          { finding: "Spam gets through", scope: "Add the honeypot field" },
          COORDINATOR,
          escalate,
        );
        assert.deepEqual(outcome, { status: "returned", attempts: attempt, threadId: WORKER });
      }
      assert.equal(fake.messages.length, 3);
      assert.equal(fake.messages[0]?.threadId, "worker");
      assert.include(fake.messages[0]!.text, "correction 1 of 3");
      assert.include(fake.messages[0]!.text, "Scope: Add the honeypot field");
      assert.include(fake.messages[0]!.text, "nothing beside it");

      const fourth = yield* initiatives.checks.returnUnit(
        task.id,
        { finding: "Still spam", scope: "Add the honeypot field" },
        COORDINATOR,
        escalate,
      );
      assert.deepEqual(fourth, { status: "escalated", attempts: 3 });
      assert.equal(fake.messages.length, 3);
      assert.equal(escalations.length, 1);
      assert.include(escalations[0]!, "im Plan");

      // A person may still send it back by hand.
      yield* initiatives.act(
        {
          type: "entryReturn",
          entryId: task.id,
          finding: "Try once more",
          scope: "Only the field",
        },
        ROBERT,
      );
      assert.equal(fake.messages.length, 4);
      const after = yield* initiatives.entries.requireEntry(task.id);
      assert.equal(after.attempts, 4);
      assert.equal(after.returns?.filter((entry) => entry.escalated).length, 1);
      assert.equal(after.status, "running");
    }),
  );
});
