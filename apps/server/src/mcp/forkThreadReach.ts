/** Fork: gates cross-project thread tools on the live environment setting. */
import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type {
  ThreadManagementError,
  ThreadManagementServiceShape,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const CROSS_PROJECT_THREADS_HINT =
  "The user can let agents reach other projects by turning on Cross-project threads in Settings → General.";

/** Whether the user turned on cross-project threads, right now. */
const crossProjectThreadsOn: Effect.Effect<boolean> = Effect.serviceOption(
  ServerSettingsService,
).pipe(
  Effect.flatMap((settings) =>
    Option.isNone(settings)
      ? Effect.succeed(false)
      : settings.value.getSettings.pipe(
          Effect.map((current) => current.enableCrossProjectThreads),
          Effect.orElseSucceed(() => false),
        ),
  ),
);

/** Fails with `message` and the hint unless cross-project threads are on. */
export const requireCrossProjectThreads = Effect.fn("forkThreadReach.requireCrossProjectThreads")(
  function* (message: string, code: OrchestratorMcpFailure["code"] = "invalid_request") {
    if (yield* crossProjectThreadsOn) return;
    return yield* new OrchestratorMcpFailure({
      code,
      message: `${message} ${CROSS_PROJECT_THREADS_HINT}`,
    });
  },
);

/**
 * The project to look the thread up in: its own when cross-project threads
 * are on, else the caller's. A thread of another project fails as not found
 * with the hint while the setting is off; a missing one falls through to the
 * lookup that follows, which reports it.
 */
export const threadProjectId = Effect.fn("forkThreadReach.threadProjectId")(function* (
  threads: Pick<ThreadManagementServiceShape, "getThreadShell">,
  threadId: ThreadId,
  callerProjectId: ProjectId,
) {
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.projectId === callerProjectId) return callerProjectId;
  yield* requireCrossProjectThreads(
    `Thread ${threadId} is not in the calling project.`,
    "thread_not_found",
  );
  return shell.projectId;
});

/**
 * The threads t3_thread_list pages through: the calling project's by default,
 * another project's with `projectId`, every project's with scope "all" (both
 * only with cross-project threads on). Same order as `listProjectThreads`.
 */
// oxlint-disable-next-line t3code/prefer-effect-fn -- exported helper runs inside the MCP operation span
export const listThreadsInScope = (
  threads: Pick<ThreadManagementServiceShape, "getShellSnapshot" | "listProjectThreads">,
  input: {
    readonly scope: "project" | "all" | undefined;
    readonly projectId: ProjectId;
    readonly callerProjectId: ProjectId;
    readonly includeSubagents: boolean;
  },
): Effect.Effect<
  ReadonlyArray<OrchestrationV2ThreadShell>,
  ThreadManagementError | OrchestratorV2Error | OrchestratorMcpFailure
> =>
  Effect.gen(function* () {
    if (input.scope === "all" || input.projectId !== input.callerProjectId) {
      yield* requireCrossProjectThreads("Only the calling project's threads can be listed.");
    }
    if (input.scope !== "all") return yield* threads.listProjectThreads(input);
    const snapshot = yield* threads.getShellSnapshot();
    return snapshot.threads
      .filter((thread) => thread.deletedAt === null)
      .filter(
        (thread) => input.includeSubagents || thread.lineage.relationshipToParent !== "subagent",
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
          right.id.localeCompare(left.id),
      );
  });
