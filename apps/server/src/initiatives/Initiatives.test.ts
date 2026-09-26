import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeTestInitiatives, TEST_PROJECT, testShell } from "./testFakes.ts";

const ROBERT = "person:robert";
const PROJECT = TEST_PROJECT;
const shellOf = (threadId: string, title: string) => testShell(threadId, { title });

const makeHarness = Effect.gen(function* () {
  const harness = yield* makeTestInitiatives;
  const created = yield* harness.initiatives.act(
    { type: "create", title: "Relaunch", goalText: "Ship it" },
    ROBERT,
  );
  return { ...harness, initiativeId: created.id! };
});

const startAction = (initiativeId: string, key: string, provider?: string) => ({
  type: "startThread" as const,
  initiativeId,
  key,
  projectId: PROJECT,
  title: "Landing page",
  prompt: "Build the landing page.",
  ...(provider ? { provider } : {}),
});

describe("Initiatives", () => {
  it.effect(
    "starts a thread in auto mode and assigns it once, however often the start repeats",
    () =>
      Effect.gen(function* () {
        const { initiatives, fake, initiativeId } = yield* makeHarness;
        const first = yield* initiatives.act(startAction(initiativeId, "submit-1"), ROBERT);
        const again = yield* initiatives.act(startAction(initiativeId, "submit-1"), ROBERT);
        assert.equal(first.id, again.id);
        assert.equal(fake.starts.length, 1);
        const started = fake.starts[0]!;
        assert.equal(started.job.spec.runtimeMode, "auto");
        assert.include(started.prompt, `<t3_initiative id="${initiativeId}"`);
        assert.include(started.prompt, "Goal: Ship it");
        const detail = yield* initiatives.detailSnapshot(initiativeId);
        assert.equal(detail.sessions.length, 1);
        assert.equal(detail.sessions[0]?.assignment, "auto");
        assert.equal(detail.sessions[0]?.threadId, first.id);
        assert.equal(detail.launchJobs[0]?.status, "started");
      }),
  );

  it.effect("falls back to accepting edits for providers without an auto reviewer", () =>
    Effect.gen(function* () {
      const { initiatives, fake, initiativeId } = yield* makeHarness;
      yield* initiatives.act(startAction(initiativeId, "submit-1", "opencode"), ROBERT);
      assert.equal(fake.starts[0]?.job.spec.runtimeMode, "auto-accept-edits");
    }),
  );

  it.effect("after a restart finishes a job whose thread exists, exactly once", () =>
    Effect.gen(function* () {
      const { initiatives, boot, fake, initiativeId } = yield* makeHarness;
      fake.state.crashAfterCreate = true;
      yield* Effect.exit(initiatives.act(startAction(initiativeId, "submit-1"), ROBERT));
      fake.state.crashAfterCreate = false;
      const before = yield* initiatives.detailSnapshot(initiativeId);
      assert.equal(before.launchJobs[0]?.status, "created");
      assert.equal(before.sessions.length, 0);

      const restarted = yield* boot;
      yield* restarted.reconcile("9999-01-01T00:00:00.000Z");
      yield* restarted.reconcile("9999-01-01T00:00:00.000Z");
      const after = yield* restarted.detailSnapshot(initiativeId);
      assert.equal(after.launchJobs[0]?.status, "started");
      assert.equal(after.sessions.length, 1);
      assert.equal(after.sessions[0]?.threadId, before.launchJobs[0]?.threadId);
      assert.equal(after.sessions[0]?.createdBy, "system:reconcile");
      assert.equal(fake.starts.length, 1);
    }),
  );

  it.effect("after a restart fails a job whose thread never came, and starts nothing", () =>
    Effect.gen(function* () {
      const { initiatives, boot, fake, store, initiativeId } = yield* makeHarness;
      // A job written just before the server died, without a thread.
      yield* store.insert(
        "launchJob",
        {
          initiativeId,
          key: "lost",
          threadId: ThreadId.make("never-created"),
          spec: {
            role: "participant",
            projectId: PROJECT,
            title: "Lost",
            prompt: "Lost",
            provider: "codex",
            model: "gpt-6",
            runtimeMode: "auto",
            worktree: true,
            baseBranch: null,
            parentThreadId: null,
          },
          status: "created",
          error: null,
        },
        ROBERT,
      );
      const restarted = yield* boot;
      yield* restarted.reconcile("9999-01-01T00:00:00.000Z");
      const after = yield* initiatives.detailSnapshot(initiativeId);
      assert.equal(after.launchJobs[0]?.status, "failed");
      assert.equal(after.sessions.length, 0);
      assert.equal(fake.starts.length, 0);
    }),
  );

  it.effect("records a failed start and lets the user dismiss it", () =>
    Effect.gen(function* () {
      const { initiatives, fake, initiativeId } = yield* makeHarness;
      fake.state.failNextStart = true;
      const error = yield* Effect.flip(
        initiatives.act(startAction(initiativeId, "submit-1"), ROBERT),
      );
      assert.include(error.message, "worktree");
      const failed = (yield* initiatives.detailSnapshot(initiativeId)).launchJobs[0]!;
      assert.equal(failed.status, "failed");
      yield* initiatives.act(
        { type: "dismissLaunch", initiativeId, launchJobId: failed.id },
        ROBERT,
      );
      assert.equal((yield* initiatives.detailSnapshot(initiativeId)).launchJobs.length, 0);
    }),
  );

  it.effect("refuses to start in a halted or archived initiative, or on an excluded provider", () =>
    Effect.gen(function* () {
      const { initiatives, store, fake, initiativeId } = yield* makeHarness;
      yield* initiatives.act(
        { type: "update", initiativeId, providerExclusions: ["claudeAgent"] },
        ROBERT,
      );
      const excluded = yield* Effect.flip(
        initiatives.act(startAction(initiativeId, "a", "claudeAgent"), ROBERT),
      );
      assert.include(excluded.message, "excluded");
      yield* store.update("initiative", initiativeId, { halted: true }, { author: ROBERT });
      assert.include(
        (yield* Effect.flip(initiatives.act(startAction(initiativeId, "b"), ROBERT))).message,
        "halted",
      );
      yield* store.update("initiative", initiativeId, { halted: false }, { author: ROBERT });
      yield* initiatives.act({ type: "archive", initiativeId }, ROBERT);
      assert.include(
        (yield* Effect.flip(initiatives.act(startAction(initiativeId, "c"), ROBERT))).message,
        "archived",
      );
      yield* initiatives.act({ type: "reopen", initiativeId }, ROBERT);
      yield* initiatives.act(startAction(initiativeId, "d"), ROBERT);
      assert.equal(fake.starts.length, 1);
    }),
  );

  it.effect("moves a thread between initiatives and releases it again", () =>
    Effect.gen(function* () {
      const { initiatives, fake, initiativeId } = yield* makeHarness;
      fake.threads.set("manual", shellOf("manual", "Manual thread"));
      const other = (yield* initiatives.act({ type: "create", title: "Other" }, ROBERT)).id!;
      const threadId = ThreadId.make("manual");
      yield* initiatives.act({ type: "assignThread", initiativeId, threadId }, ROBERT);
      yield* initiatives.act({ type: "assignThread", initiativeId: other, threadId }, ROBERT);
      assert.equal((yield* initiatives.detailSnapshot(initiativeId)).sessions.length, 0);
      const moved = (yield* initiatives.detailSnapshot(other)).sessions;
      assert.equal(moved.length, 1);
      assert.equal(moved[0]?.title, "Manual thread");
      assert.equal(moved[0]?.assignment, "confirmed");
      assert.isTrue(Option.isSome(yield* initiatives.membershipOf("manual")));

      yield* initiatives.act({ type: "unassignThread", initiativeId: other, threadId }, ROBERT);
      assert.equal((yield* initiatives.detailSnapshot(other)).sessions[0]?.assignment, "released");
      assert.isTrue(Option.isNone(yield* initiatives.membershipOf("manual")));
      const list = yield* initiatives.listSnapshot;
      assert.equal(
        list.initiatives.find((entry) => entry.initiative.id === other)?.sessionCount,
        0,
      );
    }),
  );

  it.effect("sums nothing itself but reports each assigned thread's usage", () =>
    Effect.gen(function* () {
      const { initiatives, initiativeId } = yield* makeHarness;
      const started = yield* initiatives.act(startAction(initiativeId, "submit-1"), ROBERT);
      const usage = yield* initiatives.usage(initiativeId);
      assert.deepEqual(usage.threads, [
        { threadId: ThreadId.make(started.id!), costUsd: 1.5, totalTokens: 1000 },
      ]);
    }),
  );

  it.effect("restarts the coordinator from the handoff, without its old chat", () =>
    Effect.gen(function* () {
      const { initiatives, fake, initiativeId } = yield* makeHarness;
      // No code project yet: the coordinator gets a folder of the initiative's own.
      const first = (yield* initiatives.act(
        { type: "startCoordinator", initiativeId, key: "coordinator-1" },
        ROBERT,
      )).id!;
      const firstStart = fake.starts[0]!;
      assert.equal(firstStart.job.spec.role, "coordinator");
      assert.equal(firstStart.job.spec.parentThreadId, null);
      assert.equal(firstStart.job.spec.worktree, false);
      assert.include(firstStart.prompt, 'role="coordinator"');
      assert.include(firstStart.prompt, "no handoff yet");
      assert.equal(
        fake.projects.find((project) => project.projectId === firstStart.job.spec.projectId)
          ?.workspaceRoot,
        `/state/initiatives/${initiativeId}/workspace`,
      );
      assert.isNotNull(fake.threads.get(first)?.pinnedAt);

      // The coordinator starts a thread and records where it stands.
      const child = (yield* initiatives.act(startAction(initiativeId, "task-1"), ROBERT)).id!;
      assert.equal(fake.threads.get(child)?.parentThreadId, first);
      const initiative = (yield* initiatives.detailSnapshot(initiativeId)).initiative!;
      yield* initiatives.brain.writeHandoff(
        initiative,
        {
          openTasks: ["Review the landing page"],
          lastResults: ["Landing page: PR #12 open"],
          nextStep: "Merge PR #12 after the review",
        },
        `role:coordinator:${first}`,
      );

      // A fresh coordinator starts from the handoff and takes the threads over.
      const second = (yield* initiatives.act(
        { type: "startCoordinator", initiativeId, key: "coordinator-2" },
        ROBERT,
      )).id!;
      const secondStart = fake.starts.find((start) => start.job.threadId === second)!;
      assert.include(secondStart.prompt, "Merge PR #12 after the review");
      assert.include(secondStart.prompt, "> Landing page: PR #12 open");
      assert.notInclude(secondStart.prompt, "no handoff yet");
      const after = yield* initiatives.detailSnapshot(initiativeId);
      assert.equal(after.initiative?.coordinatorThreadId, second);
      assert.isNotNull(fake.threads.get(second)?.pinnedAt);
      assert.isNull(fake.threads.get(first)?.pinnedAt);
      assert.equal(fake.threads.get(child)?.parentThreadId, second);
    }),
  );

  it.effect("shows a failed brain write until the next write succeeds", () =>
    Effect.gen(function* () {
      const { initiatives, memory, initiativeId } = yield* makeHarness;
      memory.state.failWrites = true;
      const error = yield* Effect.flip(
        initiatives.act(
          { type: "brainWrite", initiativeId, path: "details/a.md", markdown: "# A" },
          ROBERT,
        ),
      );
      assert.include(error.message, "disk full");
      assert.include(
        (yield* initiatives.detailSnapshot(initiativeId)).brainError ?? "",
        "disk full",
      );
      memory.state.failWrites = false;
      yield* initiatives.act(
        { type: "brainWrite", initiativeId, path: "details/a.md", markdown: "# A" },
        ROBERT,
      );
      const detail = yield* initiatives.detailSnapshot(initiativeId);
      assert.equal(detail.brainError, null);
      const page = detail.brainPages.find((candidate) => candidate.path === "details/a.md");
      assert.equal(page?.lockedBy, ROBERT);
      assert.equal(page?.title, "A");
    }),
  );
  it.effect("stops everything: no new starts and the running threads' turns interrupted", () =>
    Effect.gen(function* () {
      const { initiatives, fake, initiativeId } = yield* makeHarness;
      const running = yield* initiatives.act(startAction(initiativeId, "submit-1"), ROBERT);
      const idle = yield* initiatives.act(startAction(initiativeId, "submit-2"), ROBERT);
      const other = (yield* initiatives.act({ type: "create", title: "Other" }, ROBERT)).id!;
      const elsewhere = yield* initiatives.act(startAction(other, "submit-3"), ROBERT);
      for (const threadId of [running.id!, elsewhere.id!]) {
        const shell = fake.threads.get(threadId)!;
        fake.threads.set(threadId, {
          ...shell,
          session: { status: "running" },
        } as typeof shell);
      }
      const result = yield* initiatives.act({ type: "stopAll", initiativeId }, ROBERT);
      assert.equal(result.id, "1");
      assert.deepEqual(fake.interrupts, [running.id]);
      assert.notInclude(fake.interrupts, idle.id);
      const detail = yield* initiatives.detailSnapshot(initiativeId);
      assert.isTrue(detail.initiative.halted);
      yield* initiatives.act({ type: "stopAll", initiativeId: null }, ROBERT);
      assert.deepEqual(fake.interrupts, [running.id, elsewhere.id]);
      assert.isTrue((yield* initiatives.listSnapshot).halted);
    }),
  );
});
