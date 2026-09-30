/**
 * Fork: t3_thread_launch with `coordinate: true` launches the thread as one of
 * the caller's own, the way adopt_thread would put it there afterwards. The
 * link is written before the thread exists, so the thread never lists in the
 * sidebar on its own while the launch and a later adopt_thread run one after
 * the other.
 */
import { OrchestratorMcpFailure, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadCoordinators } from "../threadOrchestration/ThreadCoordinators.ts";
import { requireCrossProjectThreads } from "./forkThreadReach.ts";

export const COORDINATE_DESCRIPTION =
  "Launch the thread as one of yours, as adopt_thread would: it shows under your thread and its results reach you as updates. Use this instead of launching and then adopting. Another project than yours only when the user turned on Cross-project threads.";

export const launchUnderCoordinator = <A, E, R>(
  input: {
    readonly coordinate: boolean | undefined;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly caller: { readonly id: ThreadId; readonly projectId: ProjectId };
  },
  launch: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OrchestratorMcpFailure, R> =>
  Effect.gen(function* () {
    if (input.coordinate !== true) return yield* launch;
    const coordinators = yield* Effect.serviceOption(ThreadCoordinators);
    if (Option.isNone(coordinators)) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "This server cannot put threads under a coordinator.",
      });
    }
    if (input.projectId !== input.caller.projectId) {
      yield* requireCrossProjectThreads("The thread would be in another project than yours.");
    }
    yield* coordinators.value
      .claim({ threadId: input.threadId, coordinatorThreadId: input.caller.id })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      );
    return yield* launch.pipe(
      Effect.tapError(() => coordinators.value.unclaim(input.threadId).pipe(Effect.ignore)),
    );
  });
