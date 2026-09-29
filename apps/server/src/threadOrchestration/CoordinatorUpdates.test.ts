import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { parseThreadUpdates } from "@t3tools/shared/threadOrchestration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CoordinatorUpdates from "./CoordinatorUpdates.ts";
import { ThreadCoordinators } from "./ThreadCoordinators.ts";

const at = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const COORDINATOR = ThreadId.make("coordinator");

interface ChildState {
  readonly shell: OrchestrationV2ThreadShell;
  readonly runs: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly answers: Record<string, string>;
}

interface World {
  readonly children: Map<ThreadId, ChildState>;
  /** Coordinator links: adopted threads. */
  readonly links: Map<ThreadId, ThreadId | null>;
  /** The coordinator's V2 tasks and the child runs V2 published to it. */
  tasks: ReadonlyArray<{ childThreadId: ThreadId; completionDelivery?: { state: string } }>;
  transfers: ReadonlyArray<{ sourceThreadId: ThreadId; runId: string }>;
  queued: ReadonlyArray<{ runId: string; messageId: string; text: string }>;
  /** The last reported result of each child, as it was before a restart. */
  readonly reported: Map<ThreadId, RunId>;
}

function childShell(
  id: string,
  lineageParent: ThreadId | null,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    title: `Child ${id}`,
    creationSource: lineageParent === null ? "web" : "mcp",
    lineage: {
      parentThreadId: lineageParent,
      relationshipToParent: lineageParent === null ? null : "subagent",
      rootThreadId: lineageParent ?? ThreadId.make(id),
    },
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    lastError: null,
    pullRequests: [],
    pendingBackgroundTasks: [],
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

const run = (id: string, ordinal: number, status: string) => ({
  id: RunId.make(id),
  ordinal,
  status,
  startedAt: at,
});

const makeWorld = (): World => ({
  children: new Map(),
  links: new Map(),
  tasks: [],
  transfers: [],
  queued: [],
  reported: new Map(),
});

const withUpdates = <A, E>(
  world: World,
  body: (test: {
    readonly updates: CoordinatorUpdates.CoordinatorUpdates["Service"];
    readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>;
  }) => Effect.Effect<A, E>,
  settings: { readonly enabled: boolean } = { enabled: true },
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const reported = world.reported;
    const coordinatorShell = childShell("coordinator", null);
    const management = Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === COORDINATOR
            ? coordinatorShell
            : (world.children.get(threadId)?.shell ?? null),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [coordinatorShell, ...[...world.children.values()].map((child) => child.shell)],
          archivedThreads: [],
        }),
      getThreadRecords: ((threadId: ThreadId, fields: ReadonlyArray<string>) => {
        if (threadId === COORDINATOR) {
          return Effect.succeed({
            thread: coordinatorShell,
            subagents: world.tasks.map((task, index) => ({
              id: `task-${index}`,
              origin: "app_owned",
              status: "completed",
              ...task,
            })),
            contextTransfers: world.transfers.map((transfer) => ({
              type: "subagent_result",
              sourceThreadId: transfer.sourceThreadId,
              targetThreadId: COORDINATOR,
              sourcePoint: { threadId: transfer.sourceThreadId, runId: transfer.runId },
            })),
            runs: world.queued.map((queued, index) => ({
              id: queued.runId,
              ordinal: index + 1,
              status: "queued",
              userMessageId: queued.messageId,
            })),
            messages: world.queued.map((queued) => ({
              id: queued.messageId,
              role: "user",
              createdBy: "system",
              text: queued.text,
            })),
          });
        }
        const child = world.children.get(threadId)!;
        if (fields.includes("turnItems")) {
          return Effect.succeed({
            thread: child.shell,
            turnItems: [],
            messages: Object.entries(child.answers).map(([runId, text]) => ({
              id: `answer-${runId}`,
              runId,
              role: "assistant",
              text,
              updatedAt: at,
            })),
          });
        }
        return Effect.succeed({
          thread: child.shell,
          runs: child.runs.map((entry, index) => run(entry.id, index + 1, entry.status)),
          messages: [],
          subagents: [],
          providerThreads: [],
        });
      }) as never,
      dispatch: (command) =>
        Ref.update(dispatched, (all) => [...all, command as OrchestrationV2Command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    });
    const coordinators = Layer.mock(ThreadCoordinators)({
      overrides: Effect.sync(() => world.links),
      coordinatorOf: (thread) => {
        const link = world.links.get(thread.id);
        return Effect.succeed(
          link !== undefined
            ? link
            : thread.lineage.relationshipToParent === "subagent"
              ? thread.lineage.parentThreadId
              : null,
        );
      },
      lastReportedRun: (threadId) => Effect.succeed(reported.get(threadId) ?? null),
      markReported: (threadId, runId) => Effect.sync(() => void reported.set(threadId, runId)),
    });
    return yield* Effect.gen(function* () {
      const updates = yield* CoordinatorUpdates.CoordinatorUpdates;
      return yield* body({ updates, dispatched });
    }).pipe(
      Effect.provide(
        CoordinatorUpdates.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              management,
              coordinators,
              ServerSettings.ServerSettingsService.layerTest({
                enableThreadOrchestration: settings.enabled,
              }),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  });

const LONG_ANSWER = `Done. See [the report](docs/report.md).\n\n${"Details. ".repeat(400)}`;

describe("CoordinatorUpdates", () => {
  it.effect("reports an adopted thread's result with its full answer, once", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const adopted = ThreadId.make("adopted");
      world.links.set(adopted, COORDINATOR);
      world.children.set(adopted, {
        shell: childShell("adopted", null),
        runs: [{ id: "run-1", status: "completed" }],
        answers: { "run-1": LONG_ANSWER },
      });
      yield* withUpdates(world, ({ updates, dispatched }) =>
        Effect.gen(function* () {
          yield* updates.report(adopted);
          yield* updates.report(adopted);
          const commands = yield* Ref.get(dispatched);
          assert.strictEqual(commands.length, 1);
          const command = commands[0]!;
          assert.strictEqual(command.type, "message.dispatch");
          if (command.type !== "message.dispatch") return;
          assert.strictEqual(command.threadId, COORDINATOR);
          assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
          const [update] = parseThreadUpdates(command.text) ?? [];
          assert.strictEqual(update?.threadId, "adopted");
          assert.strictEqual(update?.state, "done");
          assert.strictEqual(update?.body, LONG_ANSWER.trim());
        }),
      );
    }),
  );

  it.effect("adds a result to the update still waiting in the coordinator's queue", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const adopted = ThreadId.make("adopted");
      world.links.set(adopted, COORDINATOR);
      world.children.set(adopted, {
        shell: childShell("adopted", null),
        runs: [{ id: "run-1", status: "failed" }],
        answers: { "run-1": "It broke." },
      });
      world.queued = [
        {
          runId: "queued-run",
          messageId: "queued-message",
          text: '<t3_thread_update thread_id="first" title="First" state="done" detail="Finished">\nFirst answer.\n</t3_thread_update>',
        },
      ];
      yield* withUpdates(world, ({ updates, dispatched }) =>
        Effect.gen(function* () {
          yield* updates.report(adopted);
          const [command] = yield* Ref.get(dispatched);
          assert.strictEqual(command?.type, "queued-run.edit");
          if (command?.type !== "queued-run.edit") return;
          assert.deepEqual(
            parseThreadUpdates(command.text)?.map((update) => [update.threadId, update.body]),
            [
              ["first", "First answer."],
              ["adopted", "It broke."],
            ],
          );
        }),
      );
    }),
  );

  it.effect("leaves a delegated child's first result to V2 and reports its follow-ups", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const child = ThreadId.make("delegated");
      const state = (runs: ChildState["runs"]): ChildState => ({
        shell: childShell("delegated", COORDINATOR),
        runs,
        answers: { "run-1": "First result.", "run-2": "Follow-up result." },
      });
      world.children.set(child, state([{ id: "run-1", status: "completed" }]));
      world.tasks = [{ childThreadId: child }];
      yield* withUpdates(world, ({ updates, dispatched }) =>
        Effect.gen(function* () {
          // V2 has not published the result yet: its mailbox delivers it.
          yield* updates.report(child);
          assert.strictEqual((yield* Ref.get(dispatched)).length, 0);
          world.transfers = [{ sourceThreadId: child, runId: "run-1" }];
          yield* updates.report(child);
          assert.strictEqual((yield* Ref.get(dispatched)).length, 0);

          // The coordinator sent a follow-up; V2 wakes it no more.
          world.children.set(
            child,
            state([
              { id: "run-1", status: "completed" },
              { id: "run-2", status: "completed" },
            ]),
          );
          yield* updates.report(child);
          const commands = yield* Ref.get(dispatched);
          assert.strictEqual(commands.length, 1);
          const command = commands[0]!;
          if (command.type !== "message.dispatch") return assert.fail(command.type);
          assert.strictEqual(parseThreadUpdates(command.text)?.[0]?.body, "Follow-up result.");
        }),
      );
    }),
  );

  it.effect("reports a result V2 disposed, for example after an interrupted coordinator turn", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const child = ThreadId.make("delegated");
      world.children.set(child, {
        shell: childShell("delegated", COORDINATOR),
        runs: [{ id: "run-1", status: "completed" }],
        answers: { "run-1": "Result." },
      });
      world.tasks = [{ childThreadId: child, completionDelivery: { state: "disposed" } }];
      world.transfers = [{ sourceThreadId: child, runId: "run-1" }];
      yield* withUpdates(world, ({ updates, dispatched }) =>
        Effect.gen(function* () {
          yield* updates.report(child);
          assert.strictEqual((yield* Ref.get(dispatched)).length, 1);
        }),
      );
    }),
  );

  it.effect("stays quiet for a thread carried over from V1 until it runs again", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const imported = ThreadId.make("imported");
      world.links.set(imported, COORDINATOR);
      world.children.set(imported, {
        shell: childShell("imported", null, { status: "idle", latestRunId: null }),
        runs: [],
        answers: {},
      });
      yield* withUpdates(world, ({ updates, dispatched }) =>
        Effect.gen(function* () {
          yield* updates.report(imported);
          assert.strictEqual((yield* Ref.get(dispatched)).length, 0);
          world.children.set(imported, {
            shell: childShell("imported", null),
            runs: [{ id: "run-1", status: "completed" }],
            answers: { "run-1": "Picked it up again." },
          });
          yield* updates.report(imported);
          assert.strictEqual((yield* Ref.get(dispatched)).length, 1);
        }),
      );
    }),
  );

  it.effect("does nothing while thread orchestration is off", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const adopted = ThreadId.make("adopted");
      world.links.set(adopted, COORDINATOR);
      world.children.set(adopted, {
        shell: childShell("adopted", null),
        runs: [{ id: "run-1", status: "completed" }],
        answers: { "run-1": "Result." },
      });
      yield* withUpdates(
        world,
        ({ updates, dispatched }) =>
          Effect.gen(function* () {
            yield* updates.report(adopted);
            assert.strictEqual((yield* Ref.get(dispatched)).length, 0);
          }),
        { enabled: false },
      );
    }),
  );
});

describe("CoordinatorUpdates.catchUp", () => {
  it.effect("reports what ended while the server was down, once, one message per coordinator", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      // Finished between the last report and the restart.
      const adopted = ThreadId.make("adopted");
      world.links.set(adopted, COORDINATOR);
      world.children.set(adopted, {
        shell: childShell("adopted", null),
        runs: [{ id: "run-1", status: "completed" }],
        answers: { "run-1": "Adopted result." },
      });
      // A follow-up of a delegated child; V2 delivered only its first result.
      const followUp = ThreadId.make("follow-up");
      world.children.set(followUp, {
        shell: childShell("follow-up", COORDINATOR),
        runs: [
          { id: "run-1", status: "completed" },
          { id: "run-2", status: "failed" },
        ],
        answers: { "run-1": "First.", "run-2": "Follow-up failed." },
      });
      // Already reported before the restart.
      const reported = ThreadId.make("reported");
      world.links.set(reported, COORDINATOR);
      world.reported.set(reported, RunId.make("run-1"));
      world.children.set(reported, {
        shell: childShell("reported", null),
        runs: [{ id: "run-1", status: "completed" }],
        answers: { "run-1": "Old news." },
      });
      // Delivered by V2's mailbox.
      const delivered = ThreadId.make("delivered");
      world.children.set(delivered, {
        shell: childShell("delivered", COORDINATOR),
        runs: [{ id: "run-1", status: "completed" }],
        answers: { "run-1": "V2 carried this." },
      });
      // Finished in V1, before the migration: no V2 run.
      const imported = ThreadId.make("imported");
      world.links.set(imported, COORDINATOR);
      world.children.set(imported, {
        shell: childShell("imported", null, { status: "idle", latestRunId: null }),
        runs: [],
        answers: {},
      });
      world.tasks = [{ childThreadId: followUp }, { childThreadId: delivered }];
      world.transfers = [
        { sourceThreadId: followUp, runId: "run-1" },
        { sourceThreadId: delivered, runId: "run-1" },
      ];
      yield* withUpdates(world, ({ updates, dispatched }) =>
        Effect.gen(function* () {
          yield* updates.catchUp;
          const commands = yield* Ref.get(dispatched);
          assert.strictEqual(commands.length, 1);
          const command = commands[0]!;
          if (command.type !== "message.dispatch") return assert.fail(command.type);
          assert.strictEqual(command.threadId, COORDINATOR);
          assert.deepEqual(
            parseThreadUpdates(command.text)?.map((update) => [update.threadId, update.body]),
            [
              ["adopted", "Adopted result."],
              ["follow-up", "Follow-up failed."],
            ],
          );
          assert.strictEqual(world.reported.get(delivered), "run-1");
          assert.isFalse(world.reported.has(imported));

          // The next start has nothing left to say.
          yield* updates.catchUp;
          assert.strictEqual((yield* Ref.get(dispatched)).length, 1);
        }),
      );
    }),
  );
});

describe("decideCoordinatorUpdate", () => {
  const base = {
    child: { settledAt: null },
    coordinator: { archivedAt: null, deletedAt: null },
    resultRunId: RunId.make("run-1"),
    lastReportedRunId: null,
    lineageTask: undefined,
    resultTransferRunIds: [],
  };

  it("keeps a settled child's result and a gone coordinator quiet", () => {
    assert.deepEqual(
      CoordinatorUpdates.decideCoordinatorUpdate({ ...base, child: { settledAt: at } }),
      { kind: "skip", accounted: RunId.make("run-1") },
    );
    assert.deepEqual(CoordinatorUpdates.decideCoordinatorUpdate({ ...base, coordinator: null }), {
      kind: "skip",
      accounted: RunId.make("run-1"),
    });
  });
});
