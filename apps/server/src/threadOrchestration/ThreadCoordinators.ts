/**
 * Fork: thread orchestration. Which coordinator thread a thread reports to.
 *
 * A thread a coordinator started (delegate_task, start_thread) belongs to it
 * by V2 lineage. Lineage is immutable, and V2's delegated-task records hang
 * off one run of the parent whose delivery V2 stops for good when that run
 * is interrupted, so neither can carry "put this thread under that
 * coordinator" or "release it". Those changes live in
 * `fork_thread_coordinators` instead: a row overrides the lineage default,
 * a row with a null coordinator releases the thread. `coordinatorThreadIdOf`
 * (shared) combines both, on the server and in the client.
 *
 * Moving a delegated child away from the thread that started it disposes that
 * parent's V2 completion delivery, so only the new coordinator hears about it
 * (CoordinatorUpdates.ts).
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadCoordinatorLink,
  ThreadCoordinatorsError,
  type ThreadCoordinatorsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

export type CoordinatorOverrides = ReadonlyMap<ThreadId, ThreadId | null>;

type CoordinatedShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "lineage" | "creationSource"
>;

const failure = (message: string) => new ThreadCoordinatorsError({ message });

/**
 * Why `thread` cannot move under `coordinator`, or null. One level deep, as
 * in V1: a coordinator is no child itself, and a thread with children of its
 * own cannot become one. That also rules out every cycle.
 */
export function coordinatorChangeError(input: {
  readonly thread: CoordinatedShell;
  readonly coordinator: CoordinatedShell;
  readonly threads: ReadonlyArray<CoordinatedShell>;
  readonly overrides: CoordinatorOverrides;
}): string | null {
  const { thread, coordinator, overrides } = input;
  if (coordinator.id === thread.id) return "A thread cannot coordinate itself.";
  if (isProviderNativeSubagentThread(thread)) {
    return `'${thread.title}' is a subagent its provider runs; only its own thread can steer it.`;
  }
  if (coordinatorThreadIdOf(coordinator, overrides) !== null) {
    return `'${coordinator.title}' belongs to a coordinator itself, and a child thread cannot coordinate threads.`;
  }
  const hasChildren = input.threads.some(
    (candidate) =>
      candidate.id !== coordinator.id && coordinatorThreadIdOf(candidate, overrides) === thread.id,
  );
  if (hasChildren) {
    return `'${thread.title}' coordinates threads of its own, so it cannot belong to another thread.`;
  }
  return null;
}

/** Runs that no longer produce output: the thread's latest result is final. */
function isSettledStatus(status: OrchestrationV2ThreadShell["status"]): boolean {
  return (
    status === "idle" ||
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

export class ThreadCoordinators extends Context.Service<
  ThreadCoordinators,
  {
    readonly overrides: Effect.Effect<CoordinatorOverrides, ThreadCoordinatorsError>;
    readonly coordinatorOf: (
      thread: CoordinatedShell,
    ) => Effect.Effect<ThreadId | null, ThreadCoordinatorsError>;
    /** The coordinator's children among the active threads, oldest first. */
    readonly childrenOf: (
      coordinatorId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadCoordinatorsError>;
    /** Puts the thread under the coordinator, or releases it with null. */
    readonly set: (
      link: ThreadCoordinatorLink,
    ) => Effect.Effect<
      { readonly previousCoordinatorThreadId: ThreadId | null },
      ThreadCoordinatorsError
    >;
    readonly subscribe: Stream.Stream<ThreadCoordinatorsSnapshot, ThreadCoordinatorsError>;
    /** The last run of the thread its coordinator heard about. */
    readonly lastReportedRun: (
      threadId: ThreadId,
    ) => Effect.Effect<RunId | null, ThreadCoordinatorsError>;
    readonly markReported: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<void, ThreadCoordinatorsError>;
  }
>()("t3/threadOrchestration/ThreadCoordinators") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );
  const storeFailed = (detail: string) => () => failure(`Could not ${detail}.`);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readLinks = sql<{
    readonly thread_id: string;
    readonly coordinator_thread_id: string | null;
  }>`
    SELECT thread_id, coordinator_thread_id FROM fork_thread_coordinators ORDER BY thread_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): ThreadCoordinatorLink => ({
        threadId: ThreadId.make(row.thread_id),
        coordinatorThreadId:
          row.coordinator_thread_id === null ? null : ThreadId.make(row.coordinator_thread_id),
      })),
    ),
    Effect.mapError(storeFailed("read the coordinator links")),
  );

  const overrides = Effect.map(
    readLinks,
    (links): CoordinatorOverrides =>
      new Map(links.map((link) => [link.threadId, link.coordinatorThreadId])),
  );

  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(storeFailed("read the thread")),
      Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
    );

  const activeShells = threads.getShellSnapshot().pipe(
    Effect.map((snapshot) => snapshot.threads.filter((thread) => thread.deletedAt === null)),
    Effect.mapError(storeFailed("list the threads")),
  );

  const childrenOf: ThreadCoordinators["Service"]["childrenOf"] = (coordinatorId) =>
    Effect.gen(function* () {
      const links = yield* overrides;
      const all = yield* activeShells;
      return all
        .filter(
          (thread) =>
            thread.id !== coordinatorId && coordinatorThreadIdOf(thread, links) === coordinatorId,
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        );
    });

  const markReported: ThreadCoordinators["Service"]["markReported"] = (threadId, runId) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO fork_thread_reports (thread_id, run_id, reported_at)
        VALUES (${threadId}, ${runId}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET run_id = excluded.run_id, reported_at = excluded.reported_at
      `;
    }).pipe(Effect.mapError(storeFailed("record the reported result")));

  const lastReportedRun: ThreadCoordinators["Service"]["lastReportedRun"] = (threadId) =>
    sql<{ readonly run_id: string }>`
      SELECT run_id FROM fork_thread_reports WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => (rows[0]?.run_id as RunId | undefined) ?? null),
      Effect.mapError(storeFailed("read the reported result")),
    );

  /**
   * V2 keeps delivering a delegated child's result to the thread that started
   * it. Once the child reports elsewhere, that delivery is disposed.
   */
  const disposeLineageDelivery = (thread: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const parentThreadId = thread.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const parent = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      const tasks = parent.subagents.filter(
        (task) =>
          task.origin === "app_owned" &&
          task.childThreadId === thread.id &&
          task.completionDelivery?.state !== "disposed",
      );
      for (const task of tasks) {
        yield* threads.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make(
            `fork:coordinator-move:${thread.id}:${yield* crypto.randomUUIDv4}`,
          ),
          parentThreadId,
          taskId: task.id,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread-coordinators.dispose-lineage-delivery-failed", {
          threadId: thread.id,
          cause,
        }),
      ),
    );

  const set: ThreadCoordinators["Service"]["set"] = (link) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const thread = yield* readShell(link.threadId);
        if (thread === null) return yield* failure(`Thread ${link.threadId} does not exist.`);
        const links = yield* overrides;
        const previous = coordinatorThreadIdOf(thread, links);
        if (link.coordinatorThreadId !== null) {
          const coordinator = yield* readShell(link.coordinatorThreadId);
          if (coordinator === null) {
            return yield* failure(`Coordinator thread ${link.coordinatorThreadId} does not exist.`);
          }
          if (coordinator.archivedAt !== null) {
            return yield* failure(`'${coordinator.title}' is archived and cannot coordinate.`);
          }
          const error = coordinatorChangeError({
            thread,
            coordinator,
            threads: yield* activeShells,
            overrides: links,
          });
          if (error !== null) return yield* failure(error);
        }
        if (previous === link.coordinatorThreadId && links.has(thread.id)) {
          return { previousCoordinatorThreadId: previous };
        }
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO fork_thread_coordinators (thread_id, coordinator_thread_id, updated_at)
          VALUES (${thread.id}, ${link.coordinatorThreadId}, ${now})
          ON CONFLICT (thread_id) DO UPDATE SET
            coordinator_thread_id = excluded.coordinator_thread_id,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(storeFailed("save the coordinator link")));
        // A thread that already finished reports its next result, not the last one.
        if (
          link.coordinatorThreadId !== previous &&
          thread.latestRunId !== null &&
          isSettledStatus(thread.status)
        ) {
          yield* markReported(thread.id, thread.latestRunId);
        }
        if (
          thread.lineage.relationshipToParent === "subagent" &&
          thread.lineage.parentThreadId !== link.coordinatorThreadId
        ) {
          yield* disposeLineageDelivery(thread);
        }
        yield* PubSub.publish(changes, undefined);
        return { previousCoordinatorThreadId: previous };
      }),
    );

  const subscribe: ThreadCoordinators["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = Effect.map(readLinks, (links) => ({ links }));
      return Stream.concat(
        Stream.fromEffect(snapshot),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
      );
    }),
  );

  return ThreadCoordinators.of({
    overrides,
    coordinatorOf: (thread) =>
      Effect.map(overrides, (links) => coordinatorThreadIdOf(thread, links)),
    childrenOf,
    set,
    subscribe,
    lastReportedRun,
    markReported,
  });
});

export const layer = Layer.effect(ThreadCoordinators, make);

/** The RPC side reads the service optionally, like ThreadDecisions.withService. */
export const withService = <A>(
  use: (service: ThreadCoordinators["Service"]) => Effect.Effect<A, ThreadCoordinatorsError>,
) =>
  Effect.flatMap(Effect.serviceOption(ThreadCoordinators), (service) =>
    service._tag === "Some"
      ? use(service.value)
      : Effect.fail(failure("This server does not keep coordinator links.")),
  );

export const subscribeRpc = () =>
  Stream.unwrap(withService((service) => Effect.succeed(service.subscribe)));

export const setRpc = (link: ThreadCoordinatorLink) =>
  withService((service) => service.set(link)).pipe(Effect.as({}));
