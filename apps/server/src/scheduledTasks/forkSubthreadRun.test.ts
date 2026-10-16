import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadLaunchServiceModule from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ThreadCoordinators } from "../threadOrchestration/ThreadCoordinators.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project:test");
const boundThreadId = ThreadId.make("thread:coordinator");
const foreignThreadId = ThreadId.make("thread:other-project");
/** Threads the mock reports as deleted. */
const deletedThreads = new Set<ThreadId>();

const taskInput = (
  overrides: Partial<ScheduledTaskUpsertInput> = {},
): ScheduledTaskUpsertInput => ({
  title: "Nightly triage",
  prompt: "Triage new issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId,
  threadId: boundThreadId,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...overrides,
});

const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
    readonly claims: Array<{ threadId: ThreadId; coordinatorThreadId: ThreadId }>;
    readonly sends: Array<unknown>;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const claims: Array<{ threadId: ThreadId; coordinatorThreadId: ThreadId }> = [];
    const sends: Array<unknown> = [];
    const dependencies = Layer.mergeAll(
      NodePlatformCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchServiceModule.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => launches.push(input)).pipe(
            Effect.as({ threadId: input.threadId, resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getProjectThreadRecords: (input) =>
          Effect.succeed({
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              title: "Coordinator",
              archivedAt: null,
              worktreePath: "/repo/.worktrees/feature",
              branch: "feature",
            },
          } as never),
        sendToThread: (input) => Effect.sync(() => sends.push(input)).pipe(Effect.as({} as never)),
        getThreadShell: (threadId) =>
          Effect.succeed(
            deletedThreads.has(threadId)
              ? null
              : threadId === boundThreadId
                ? ({ id: threadId, projectId, title: "Coordinator" } as never)
                : threadId === foreignThreadId
                  ? ({
                      id: threadId,
                      projectId: ProjectId.make("project:other"),
                      title: "Elsewhere",
                    } as never)
                  : null,
          ),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ThreadCoordinators)({
        claim: (link) => Effect.sync(() => void claims.push(link)),
        unclaim: () => Effect.void,
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({ service, launches, claims, sends });
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("a subthread run launches a child under the bound thread and posts nothing there", () =>
  withService(({ service, launches, claims, sends }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(taskInput({ spawnAsSubthread: true }));
      assert.equal(task.spawnAsSubthread, true);

      const { task: ran } = yield* service.runNow({ id: task.id });
      assert.equal(ran.lastRunStatus, "succeeded");
      assert.deepEqual(sends, []);
      assert.equal(launches.length, 1);
      const launch = launches[0]!;
      assert.equal(launch.title, "Nightly triage");
      assert.equal(launch.initialMessage?.text, "Triage new issues");
      assert.equal(launch.initialMessage?.scheduledTaskId, task.id);
      // The parent's checkout, not a worktree of its own.
      assert.deepEqual(launch.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/repo/.worktrees/feature",
        branch: "feature",
      });
      // Claimed before the launch, under the run's own command id, so a
      // replayed run reaches the same thread.
      assert.deepEqual(claims, [
        { threadId: launch.threadId!, coordinatorThreadId: boundThreadId },
      ]);
      assert.equal(launch.threadId, ThreadId.make(launch.commandId));

      // Same instant (the test clock is frozen) means the same fire key.
      yield* service.runNow({ id: task.id });
      assert.equal(launches.length, 2);
      assert.equal(launches[1]!.commandId, launch.commandId);
      assert.equal(launches[1]!.threadId, launch.threadId);
    }),
  ),
);

it.effect("keeps the setting on saves that omit it and drops it when unbound", () =>
  withService(({ service, launches, sends }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(taskInput({ spawnAsSubthread: true }));
      // An older client edits the task without knowing the setting.
      const { task: edited } = yield* service.upsert(taskInput({ id: task.id, title: "Renamed" }));
      assert.equal(edited.spawnAsSubthread, true);

      const { task: off } = yield* service.upsert(
        taskInput({ id: task.id, spawnAsSubthread: false }),
      );
      assert.isUndefined(off.spawnAsSubthread);
      yield* service.runNow({ id: task.id });
      assert.equal(sends.length, 1);
      assert.equal(launches.length, 0);

      const { task: unbound } = yield* service.upsert(
        taskInput({ id: task.id, threadId: null, spawnAsSubthread: true }),
      );
      assert.isUndefined(unbound.spawnAsSubthread);
    }),
  ),
);

it.effect("refuses binding to a thread of another project or one that does not exist", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const foreign = yield* Effect.flip(service.upsert(taskInput({ threadId: foreignThreadId })));
      assert.include(foreign.message, "another project");
      const missing = yield* Effect.flip(
        service.upsert(taskInput({ threadId: ThreadId.make("thread:missing") })),
      );
      assert.include(missing.message, "does not exist");

      // A saved binding is not rechecked, so a task whose thread is gone stays editable.
      const { task } = yield* service.upsert(taskInput());
      deletedThreads.add(boundThreadId);
      const { task: renamed } = yield* service
        .upsert(taskInput({ id: task.id, title: "Renamed" }))
        .pipe(Effect.ensuring(Effect.sync(() => deletedThreads.delete(boundThreadId))));
      assert.equal(renamed.title, "Renamed");
    }),
  ),
);
