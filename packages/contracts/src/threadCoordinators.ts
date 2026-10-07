/**
 * Fork: which coordinator thread a thread reports to, where that differs from
 * its lineage. A thread a coordinator started with delegate_task belongs to it
 * by lineage; the user (or a coordinator) can put any thread under a
 * coordinator, move it to another one, or release it. Lineage never changes,
 * so these links carry the change: a link with a null coordinator releases
 * the thread. See `coordinatorThreadIdOf` in @t3tools/shared/threadOrchestration.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

export const THREAD_COORDINATORS_WS_METHODS = {
  subscribe: "threadCoordinators.subscribe",
  set: "threadCoordinators.set",
} as const;

export const ThreadCoordinatorLink = Schema.Struct({
  threadId: ThreadId,
  /** Null: the thread was released and reports to no coordinator. */
  coordinatorThreadId: Schema.NullOr(ThreadId),
});
export type ThreadCoordinatorLink = typeof ThreadCoordinatorLink.Type;

/** Every link of the environment; each change sends the full list again, it stays small. */
export const ThreadCoordinatorsSnapshot = Schema.Struct({
  links: Schema.Array(ThreadCoordinatorLink),
});
export type ThreadCoordinatorsSnapshot = typeof ThreadCoordinatorsSnapshot.Type;

export class ThreadCoordinatorsError extends Schema.TaggedError<ThreadCoordinatorsError>()(
  "ThreadCoordinatorsError",
  { message: Schema.String },
) {}

export const WsThreadCoordinatorsSubscribeRpc = Rpc.make(THREAD_COORDINATORS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: ThreadCoordinatorsSnapshot,
  error: Schema.Union([ThreadCoordinatorsError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Puts the thread under the coordinator, or releases it with null. */
export const WsThreadCoordinatorsSetRpc = Rpc.make(THREAD_COORDINATORS_WS_METHODS.set, {
  payload: ThreadCoordinatorLink,
  success: Schema.Struct({}),
  error: Schema.Union([ThreadCoordinatorsError, EnvironmentAuthorizationError]),
});
