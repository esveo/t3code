import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { resolveChildThreadState } from "@t3tools/shared/threadOrchestration";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ensureForkSchema } from "./forkSchema.ts";
import * as ThreadOrchestrationReactor from "./ThreadOrchestrationReactor.ts";

const engineLayer = it.layer(
  ThreadOrchestrationReactor.layer
    .pipe(
      Layer.provideMerge(ServerSettings.layerTest({ enableThreadOrchestration: true })),
      Layer.provideMerge(OrchestrationEngineLive),
    )
    .pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-orchestration-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
);

engineLayer("thread orchestration", (it) => {
  it.effect("a child thread keeps its coordinator through later updates", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const createdAt = "2026-09-23T10:00:00.000Z";
      const projectId = ProjectId.make("project-orchestration");
      const coordinatorId = ThreadId.make("thread-coordinator");
      const childId = ThreadId.make("thread-child");
      const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
      const create = (threadId: ThreadId, parentThreadId?: ThreadId) =>
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-create-${threadId}`),
          threadId,
          projectId,
          ...(parentThreadId ? { parentThreadId } : {}),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId,
        title: "Orchestration",
        workspaceRoot: "/tmp/project-orchestration",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* create(coordinatorId);
      yield* create(childId, coordinatorId);
      // Every other thread write upserts the whole row; the parent must survive them.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-child-meta"),
        threadId: childId,
        branch: "t3code/abcd1234",
        worktreePath: "/tmp/worktrees/child",
      });

      const child = yield* snapshots.getThreadShellById(childId);
      const coordinator = yield* snapshots.getThreadShellById(coordinatorId);
      assert.strictEqual(Option.getOrThrow(child).parentThreadId, coordinatorId);
      assert.strictEqual(Option.getOrThrow(child).branch, "t3code/abcd1234");
      assert.strictEqual(Option.getOrThrow(coordinator).parentThreadId, undefined);

      const shell = yield* snapshots.getShellSnapshot();
      assert.deepEqual(
        shell.threads.filter((thread) => thread.parentThreadId === coordinatorId).map((t) => t.id),
        [childId],
      );
      const detail = yield* snapshots.getThreadDetailById(childId);
      assert.strictEqual(Option.getOrThrow(detail).parentThreadId, coordinatorId);
    }),
  );

  it.effect("a coordinator's children follow it into and out of settled", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const reactor = yield* ThreadOrchestrationReactor.ThreadOrchestrationReactor;
      yield* reactor.start();
      const createdAt = "2026-09-23T11:00:00.000Z";
      const projectId = ProjectId.make("project-settle");
      const coordinatorId = ThreadId.make("settle-coordinator");
      const finishedId = ThreadId.make("settle-finished");
      const workingId = ThreadId.make("settle-working");
      const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-settle-project"),
        projectId,
        title: "Settle",
        workspaceRoot: "/tmp/project-settle",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      for (const [threadId, parentThreadId] of [
        [coordinatorId, undefined],
        [finishedId, coordinatorId],
        [workingId, coordinatorId],
      ] as const) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-settle-create-${threadId}`),
          threadId,
          projectId,
          ...(parentThreadId ? { parentThreadId } : {}),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-settle-working-session"),
        threadId: workingId,
        session: {
          threadId: workingId,
          status: "running",
          providerName: "claudeAgent",
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cmd-settle-coordinator"),
        threadId: coordinatorId,
      });
      yield* reactor.drain;

      const settledAt = (threadId: ThreadId) =>
        snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.map((thread) => Option.getOrThrow(thread).settledAt));
      assert.notStrictEqual(yield* settledAt(finishedId), null);
      // A child that still works stays open.
      assert.strictEqual(yield* settledAt(workingId), null);

      // Bringing the coordinator back brings its children back.
      yield* engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("cmd-unsettle-coordinator"),
        threadId: coordinatorId,
        reason: "user",
      });
      yield* reactor.drain;
      assert.strictEqual(yield* settledAt(coordinatorId), null);
      assert.strictEqual(yield* settledAt(finishedId), null);
    }),
  );

  it.effect("a child whose subagents outlive its turn is reported once they are done", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      const reactor = yield* ThreadOrchestrationReactor.ThreadOrchestrationReactor;
      yield* reactor.start();
      const createdAt = "2026-09-23T12:00:00.000Z";
      const projectId = ProjectId.make("project-background");
      const coordinatorId = ThreadId.make("background-coordinator");
      const childId = ThreadId.make("background-child");
      const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-background-project"),
        projectId,
        title: "Background",
        workspaceRoot: "/tmp/project-background",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      for (const [threadId, parentThreadId] of [
        [coordinatorId, undefined],
        [childId, coordinatorId],
      ] as const) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-background-create-${threadId}`),
          threadId,
          projectId,
          ...(parentThreadId ? { parentThreadId } : {}),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-background-answer-delta"),
        threadId: childId,
        messageId: MessageId.make("background-answer"),
        delta: "Two subagents are on it. I will write the report once they are back.",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-background-answer-complete"),
        threadId: childId,
        messageId: MessageId.make("background-answer"),
        createdAt,
      });
      const updates = snapshots
        .getThreadDetailById(coordinatorId)
        .pipe(
          Effect.map((detail) =>
            Option.getOrThrow(detail).messages.filter((message) =>
              message.text.includes("t3_thread_update"),
            ),
          ),
        );

      // The turn ends while a subagent runs on.
      liveness.recordTaskLiveness({
        threadId: childId,
        taskId: "subagent-1",
        taskType: "local_agent",
        status: undefined,
        kind: "started",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-background-ready"),
        threadId: childId,
        session: {
          threadId: childId,
          status: "ready",
          providerName: "claudeAgent",
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      yield* reactor.drain;
      assert.strictEqual((yield* updates).length, 0);

      // The subagent ends and no turn follows: the grace period reports the child.
      liveness.recordTaskLiveness({
        threadId: childId,
        taskId: "subagent-1",
        taskType: "local_agent",
        status: "completed",
        kind: "completed",
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-background-task-completed"),
        threadId: childId,
        activity: {
          id: EventId.make("background-task-completed"),
          tone: "info",
          kind: "task.completed",
          summary: "Task completed",
          payload: { taskId: "subagent-1", status: "completed" },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      yield* reactor.drain;
      assert.strictEqual((yield* updates).length, 0);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* reactor.drain;
      const reported = yield* updates;
      assert.strictEqual(reported.length, 1);
      assert.include(reported[0]!.text, 'state="done"');

      // Later session writes do not report the same finish again.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-background-ready-again"),
        threadId: childId,
        session: {
          threadId: childId,
          status: "ready",
          providerName: "claudeAgent",
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-09-23T12:01:00.000Z",
        },
        createdAt: "2026-09-23T12:01:00.000Z",
      });
      yield* reactor.drain;
      assert.strictEqual((yield* updates).length, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an existing thread moves under a coordinator and out again", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const reactor = yield* ThreadOrchestrationReactor.ThreadOrchestrationReactor;
      yield* reactor.start();
      const createdAt = "2026-09-23T12:00:00.000Z";
      const projectId = ProjectId.make("project-adopt");
      const otherProjectId = ProjectId.make("project-adopt-other");
      const coordinatorId = ThreadId.make("adopt-coordinator");
      const analysisId = ThreadId.make("adopt-analysis");
      const startedId = ThreadId.make("adopt-started");
      const otherCoordinatorId = ThreadId.make("adopt-other-coordinator");
      const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
      for (const [id, workspaceRoot] of [
        [projectId, "/tmp/project-adopt"],
        [otherProjectId, "/tmp/project-adopt-other"],
      ] as const) {
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`cmd-adopt-project-${id}`),
          projectId: id,
          title: id,
          workspaceRoot,
          defaultModelSelection: modelSelection,
          createdAt,
        });
      }
      for (const [threadId, threadProjectId, parentThreadId] of [
        [coordinatorId, projectId, undefined],
        [analysisId, otherProjectId, undefined],
        [otherCoordinatorId, projectId, undefined],
        [startedId, projectId, otherCoordinatorId],
      ] as const) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-adopt-create-${threadId}`),
          threadId,
          projectId: threadProjectId,
          ...(parentThreadId ? { parentThreadId } : {}),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      const setParent = (threadId: ThreadId, parentThreadId: ThreadId | null, tag: string) =>
        engine.dispatch({
          type: "thread.parent.set",
          commandId: CommandId.make(`cmd-adopt-parent-${tag}`),
          threadId,
          parentThreadId,
        });
      const parentOf = (threadId: ThreadId) =>
        snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.map((thread) => Option.getOrThrow(thread).parentThreadId));
      const rejection = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );

      // A thread of another project can be adopted, as start_thread may start one there.
      yield* setParent(analysisId, coordinatorId, "adopt");
      assert.strictEqual(yield* parentOf(analysisId), coordinatorId);
      // Later whole-row upserts keep the new parent.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-adopt-meta"),
        threadId: analysisId,
        title: "DocGen analysis",
      });
      assert.strictEqual(yield* parentOf(analysisId), coordinatorId);

      assert.include(
        yield* rejection(setParent(coordinatorId, coordinatorId, "self")),
        "own parent",
      );
      assert.include(
        yield* rejection(setParent(coordinatorId, ThreadId.make("missing"), "missing")),
        "does not exist",
      );
      // One level deep: a child cannot coordinate, and a coordinator cannot become a child.
      assert.include(
        yield* rejection(setParent(otherCoordinatorId, analysisId, "under-child")),
        "belongs to another thread",
      );
      assert.include(
        yield* rejection(setParent(coordinatorId, otherCoordinatorId, "coordinator")),
        "coordinates threads of its own",
      );

      // The adopted thread reports to its new coordinator like one it started.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-adopt-session"),
        threadId: analysisId,
        session: {
          threadId: analysisId,
          status: "error",
          providerName: "claudeAgent",
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Out of tokens",
          updatedAt: createdAt,
        },
        createdAt,
      });
      yield* reactor.drain;
      const coordinatorDetail = Option.getOrThrow(
        yield* snapshots.getThreadDetailById(coordinatorId),
      );
      assert.include(coordinatorDetail.messages.at(-1)?.text ?? "", `thread_id="${analysisId}"`);

      // Taking it out again clears the parent in the projection, not only in memory.
      yield* setParent(analysisId, null, "detach");
      assert.strictEqual(yield* parentOf(analysisId), undefined);
      const shell = yield* snapshots.getShellSnapshot();
      assert.isFalse(shell.threads.some((thread) => thread.parentThreadId === coordinatorId));
    }),
  );

  it.effect("an adopted thread with running subagents stays working and reports done once", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      const reactor = yield* ThreadOrchestrationReactor.ThreadOrchestrationReactor;
      yield* reactor.start();
      const createdAt = "2026-09-23T12:00:00.000Z";
      const projectId = ProjectId.make("project-adopt-background");
      const coordinatorId = ThreadId.make("adopt-background-coordinator");
      const threadId = ThreadId.make("adopt-background-thread");
      const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-adopt-background-project"),
        projectId,
        title: "Adopt background",
        workspaceRoot: "/tmp/project-adopt-background",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      for (const id of [coordinatorId, threadId]) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-adopt-background-create-${id}`),
          threadId: id,
          projectId,
          title: id,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-adopt-background-delta"),
        threadId,
        messageId: MessageId.make("adopt-background-answer"),
        delta: "A subagent is on it.",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-adopt-background-complete"),
        threadId,
        messageId: MessageId.make("adopt-background-answer"),
        createdAt,
      });
      const updates = snapshots
        .getThreadDetailById(coordinatorId)
        .pipe(
          Effect.map((detail) =>
            Option.getOrThrow(detail).messages.filter((message) =>
              message.text.includes("t3_thread_update"),
            ),
          ),
        );
      const stateOf = snapshots
        .getThreadShellById(threadId)
        .pipe(Effect.map((thread) => resolveChildThreadState(Option.getOrThrow(thread))));
      const sessionReady = (tag: string, updatedAt: string) =>
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-adopt-background-${tag}`),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            providerInstanceId: modelSelection.instanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt,
          },
          createdAt: updatedAt,
        });

      // Its turn ends while a subagent runs on, before it has a coordinator.
      liveness.recordTaskLiveness({
        threadId,
        taskId: "subagent-1",
        taskType: "local_agent",
        status: undefined,
        kind: "started",
      });
      yield* sessionReady("ready", createdAt);
      yield* engine.dispatch({
        type: "thread.parent.set",
        commandId: CommandId.make("cmd-adopt-background-parent"),
        threadId,
        parentThreadId: coordinatorId,
      });
      yield* reactor.drain;
      assert.strictEqual(yield* stateOf, "working");
      assert.strictEqual((yield* updates).length, 0);

      // The subagent ends and no turn follows: the new coordinator hears once.
      liveness.recordTaskLiveness({
        threadId,
        taskId: "subagent-1",
        taskType: "local_agent",
        status: "completed",
        kind: "completed",
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-adopt-background-task-completed"),
        threadId,
        activity: {
          id: EventId.make("adopt-background-task-completed"),
          tone: "info",
          kind: "task.completed",
          summary: "Task completed",
          payload: { taskId: "subagent-1", status: "completed" },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      yield* TestClock.adjust(Duration.seconds(30));
      yield* reactor.drain;
      assert.strictEqual(yield* stateOf, "done");
      yield* sessionReady("ready-again", "2026-09-23T12:01:00.000Z");
      yield* reactor.drain;
      const reported = yield* updates;
      assert.strictEqual(reported.length, 1);
      assert.include(reported[0]!.text, 'state="done"');
      assert.include(reported[0]!.text, `thread_id="${threadId}"`);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("the fork schema step is safe to run again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureForkSchema;
      yield* ensureForkSchema;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.strictEqual(columns.filter((column) => column.name === "parent_thread_id").length, 1);
    }),
  );
});
