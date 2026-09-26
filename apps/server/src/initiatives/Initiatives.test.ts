import { assert, describe, it } from "@effect/vitest";
import {
  type InitiativeLaunchJob,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { type ThreadBridge, ThreadBridgeError } from "@t3tools/initiatives/bridge";
import { ensureInitiativeSchema, makeInitiativeStore } from "@t3tools/initiatives/store";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeInitiatives } from "./Initiatives.ts";

const ROBERT = "person:robert";
const PROJECT = ProjectId.make("project-1");

const shellOf = (threadId: string, title: string) =>
  ({
    id: ThreadId.make(threadId),
    projectId: PROJECT,
    title,
    branch: "feature",
    worktreePath: "/worktrees/feature",
  }) as OrchestrationThreadShell;

/**
 * A bridge over an in-memory thread list. `failNextStart` makes the next
 * start fail; `crashAfterCreate` creates the thread and then fails, as a
 * server dying between creating the thread and recording it would.
 */
const makeBridge = () => {
  const threads = new Map<string, OrchestrationThreadShell>();
  const starts: Array<{ job: InitiativeLaunchJob; prompt: string }> = [];
  const state = { failNextStart: false, crashAfterCreate: false };
  const bridge: ThreadBridge = {
    capabilities: { runtimeModes: ["auto"], lineage: "one-level" },
    resolveModel: (input) =>
      Effect.succeed({
        modelSelection: {
          instanceId: ProviderInstanceId.make(input.provider ?? "codex"),
          model: input.model ?? "gpt-6",
        },
        driver: input.provider === "opencode" ? "opencode" : (input.provider ?? "codex"),
      }),
    startThread: (job, prompt) =>
      Effect.suspend(() => {
        if (state.failNextStart) {
          state.failNextStart = false;
          return Effect.fail(new ThreadBridgeError({ message: "Could not create the worktree" }));
        }
        if (threads.has(job.threadId)) {
          return Effect.fail(new ThreadBridgeError({ message: "Thread exists" }));
        }
        starts.push({ job, prompt });
        threads.set(job.threadId, shellOf(job.threadId, job.spec.title));
        if (state.crashAfterCreate) return Effect.die("server stopped");
        return Effect.succeed({ threadId: job.threadId, branch: "feature", worktree: true });
      }),
    findThread: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
    listThreads: () => Effect.succeed([...threads.values()]),
    listProjects: () =>
      Effect.succeed([{ projectId: PROJECT, title: "Web", workspaceRoot: "/repo/web" }]),
  };
  return { bridge, threads, starts, state };
};

const makeHarness = Effect.gen(function* () {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* ensureInitiativeSchema(sql);
  let counter = 0;
  const newId = Effect.sync(() => `id-${++counter}`);
  const store = makeInitiativeStore({ sql, newId });
  const fake = makeBridge();
  /** A server process on the same database; call it again for a restart. */
  const boot = makeInitiatives({
    store,
    bridge: fake.bridge,
    newId,
    environmentId: null,
    readUsage: () => Effect.succeed({ costUsd: 1.5, totalTokens: 1000 }),
  });
  const initiatives = yield* boot;
  const created = yield* initiatives.act(
    { type: "create", title: "Relaunch", goalText: "Ship it" },
    ROBERT,
  );
  return { initiatives, boot, store, fake, initiativeId: created.id! };
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
});
