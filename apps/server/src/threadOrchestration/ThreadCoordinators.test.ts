import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadCoordinators from "./ThreadCoordinators.ts";

const at = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    title: id,
    projectId: "project-1",
    createdBy: "user",
    creationSource: "web",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    status: "idle",
    latestRunId: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

/** A child `coordinator` started with delegate_task, finished with `runId`. */
function delegatedChild(id: string, coordinator: string, runId: string) {
  return shell(id, {
    creationSource: "mcp",
    status: "completed",
    latestRunId: RunId.make(runId),
    lineage: {
      parentThreadId: ThreadId.make(coordinator),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make(coordinator),
    },
  });
}

const withService = <A, E>(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  body: (test: {
    readonly service: ThreadCoordinators.ThreadCoordinators["Service"];
    readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const management = Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(byId.get(threadId) ?? null),
      getShellSnapshot: () =>
        Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads, archivedThreads: [] }),
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.succeed({
          subagents: threads
            .filter((thread) => thread.lineage.parentThreadId === threadId)
            .map((thread) => ({
              id: NodeId.make(`task:${thread.id}`),
              origin: "app_owned",
              childThreadId: thread.id,
              completionDelivery: { state: "delivered", observedByRunId: null },
            })),
        })) as never,
      dispatch: (command) =>
        Ref.update(dispatched, (all) => [...all, command as OrchestrationV2Command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    });
    return yield* Effect.gen(function* () {
      const service = yield* ThreadCoordinators.ThreadCoordinators;
      return yield* body({ service, dispatched });
    }).pipe(
      Effect.provide(
        ThreadCoordinators.layer.pipe(
          Layer.provide(Layer.mergeAll(management, SqlitePersistenceMemory, NodeServices.layer)),
        ),
      ),
    );
  });

describe("ThreadCoordinators", () => {
  it.effect("adopts an existing thread, moves it and releases it", () =>
    Effect.gen(function* () {
      const threads = [
        shell("coord-a"),
        shell("coord-b"),
        shell("loose", { latestRunId: RunId.make("run-9"), status: "completed" }),
      ];
      return yield* withService(threads, ({ service }) =>
        Effect.gen(function* () {
          const loose = threads[2]!;

          assert.strictEqual(yield* service.coordinatorOf(loose), null);
          const adopted = yield* service.set({
            threadId: loose.id,
            coordinatorThreadId: ThreadId.make("coord-a"),
          });
          assert.strictEqual(adopted.previousCoordinatorThreadId, null);
          assert.strictEqual(yield* service.coordinatorOf(loose), "coord-a");
          assert.deepEqual(
            (yield* service.childrenOf(ThreadId.make("coord-a"))).map((thread) => thread.id),
            ["loose"],
          );
          // Its last result is old news for the new coordinator.
          assert.strictEqual(yield* service.lastReportedRun(loose.id), "run-9");

          const moved = yield* service.set({
            threadId: loose.id,
            coordinatorThreadId: ThreadId.make("coord-b"),
          });
          assert.strictEqual(moved.previousCoordinatorThreadId, "coord-a");
          assert.strictEqual(yield* service.coordinatorOf(loose), "coord-b");
          assert.strictEqual((yield* service.childrenOf(ThreadId.make("coord-a"))).length, 0);

          yield* service.set({ threadId: loose.id, coordinatorThreadId: null });
          assert.strictEqual(yield* service.coordinatorOf(loose), null);
        }),
      );
    }),
  );

  it.effect("moving a delegated child away disposes its starter's delivery", () =>
    Effect.gen(function* () {
      const threads = [
        shell("starter"),
        shell("other"),
        delegatedChild("child", "starter", "run-1"),
      ];
      return yield* withService(threads, ({ service, dispatched }) =>
        Effect.gen(function* () {
          const child = threads[2]!;
          assert.strictEqual(yield* service.coordinatorOf(child), "starter");

          yield* service.set({ threadId: child.id, coordinatorThreadId: ThreadId.make("other") });
          assert.strictEqual(yield* service.coordinatorOf(child), "other");
          assert.deepEqual(
            (yield* Ref.get(dispatched)).map((command) =>
              command.type === "delegated_task.completion-delivery.dispose"
                ? [command.type, command.parentThreadId, command.taskId]
                : [command.type],
            ),
            [["delegated_task.completion-delivery.dispose", "starter", "task:child"]],
          );
        }),
      );
    }),
  );

  it.effect("keeps coordination one level deep", () =>
    Effect.gen(function* () {
      const threads = [
        shell("coord"),
        delegatedChild("child", "coord", "run-1"),
        shell("loose"),
        shell("native", {
          creationSource: "provider",
          lineage: {
            parentThreadId: ThreadId.make("loose"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("loose"),
          },
        }),
      ];
      return yield* withService(threads, ({ service }) =>
        Effect.gen(function* () {
          const refused = (threadId: string, coordinatorThreadId: string) =>
            service
              .set({
                threadId: ThreadId.make(threadId),
                coordinatorThreadId: ThreadId.make(coordinatorThreadId),
              })
              .pipe(
                Effect.flip,
                Effect.map((error) => error.message),
              );
          // A child cannot coordinate, and a coordinator cannot become a child.
          assert.include(yield* refused("loose", "child"), "belongs to a coordinator itself");
          assert.include(yield* refused("coord", "loose"), "coordinates threads of its own");
          assert.include(yield* refused("loose", "loose"), "cannot coordinate itself");
          assert.include(yield* refused("native", "coord"), "subagent its provider runs");
        }),
      );
    }),
  );

  it.effect("sends the links to subscribers", () =>
    Effect.gen(function* () {
      const threads = [shell("coord"), shell("loose")];
      return yield* withService(threads, ({ service }) =>
        Effect.gen(function* () {
          yield* service.set({
            threadId: ThreadId.make("loose"),
            coordinatorThreadId: ThreadId.make("coord"),
          });
          const snapshot = yield* Stream.runHead(service.subscribe);
          assert.deepEqual(Option.getOrThrow(snapshot).links, [
            { threadId: ThreadId.make("loose"), coordinatorThreadId: ThreadId.make("coord") },
          ]);
        }),
      );
    }),
  );
});
