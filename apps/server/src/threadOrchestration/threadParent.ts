/**
 * Fork: thread orchestration. An existing thread can be put under a
 * coordinator thread later, or taken out again (`thread.parent.set`). The
 * coordinator then treats it like a thread it started: the thread tools reach
 * it and its updates arrive as turns, because both only read `parentThreadId`.
 *
 * The rules match start_thread: any project, one level deep. A child cannot
 * coordinate, so the parent must not be a child itself and a thread with
 * children of its own cannot become one. That also rules out every cycle.
 */
import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

type ThreadParentSetCommand = Extract<OrchestrationCommand, { type: "thread.parent.set" }>;

const reject = (detail: string) =>
  new OrchestrationCommandInvariantError({ commandType: "thread.parent.set", detail });

const liveThread = (readModel: OrchestrationReadModel, threadId: ThreadId) =>
  readModel.threads.find((thread) => thread.id === threadId && thread.deletedAt === null);

/** The payload of `thread.parent-set`, or why the thread cannot move there. */
export const decideThreadParentSet = Effect.fn("decideThreadParentSet")(function* (input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ThreadParentSetCommand;
  readonly occurredAt: string;
}) {
  const { readModel, command } = input;
  const thread = liveThread(readModel, command.threadId);
  if (!thread) return yield* reject(`Thread '${command.threadId}' does not exist.`);
  const parentThreadId = command.parentThreadId;
  if (parentThreadId !== null) {
    if (parentThreadId === thread.id) {
      return yield* reject("A thread cannot be its own parent.");
    }
    const parent = liveThread(readModel, parentThreadId);
    if (!parent) return yield* reject(`Parent thread '${parentThreadId}' does not exist.`);
    if (parent.parentThreadId) {
      return yield* reject(
        `'${parent.title}' belongs to another thread itself, and a child thread cannot coordinate threads.`,
      );
    }
    const hasChildren = readModel.threads.some(
      (candidate) => candidate.parentThreadId === thread.id && candidate.deletedAt === null,
    );
    if (hasChildren) {
      return yield* reject(
        `'${thread.title}' coordinates threads of its own, so it cannot belong to another thread.`,
      );
    }
  }
  // Idempotent by re-emission, like thread.unpin: the same parent again keeps updatedAt.
  const unchanged = (thread.parentThreadId ?? null) === parentThreadId;
  return {
    threadId: thread.id,
    parentThreadId,
    updatedAt: unchanged ? thread.updatedAt : input.occurredAt,
  };
});

/** The read-model thread under its new parent, or without one. */
export function withParentThread(
  thread: OrchestrationThread,
  parentThreadId: ThreadId | null,
  updatedAt: string,
): OrchestrationThread {
  const { parentThreadId: _previous, ...rest } = thread;
  return parentThreadId === null ? { ...rest, updatedAt } : { ...rest, parentThreadId, updatedAt };
}

/**
 * The projection row's parent. A direct update, because the repository's
 * upsert keeps the parent it has (see ProjectionThreads) and so cannot clear it.
 */
export const projectThreadParentSet = (
  sql: SqlClient.SqlClient,
  payload: {
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId | null;
    readonly updatedAt: string;
  },
) =>
  sql`
    UPDATE projection_threads
    SET parent_thread_id = ${payload.parentThreadId}, updated_at = ${payload.updatedAt}
    WHERE thread_id = ${payload.threadId}
  `.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.setParent:query")),
  );
