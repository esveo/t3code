/**
 * Fork: the t3_thread_* tools reach threads in every project of the
 * environment, not only the calling thread's, so a coordinator can read,
 * message and settle its children wherever they run (delegate_task's
 * `workspace.project`, adopt_thread). Every other check stays: a live caller,
 * modes not broader than the caller's, and so on. t3_thread_list and
 * t3_thread_search still default to the calling project.
 */
import { type OrchestrationV2ThreadShell, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type {
  ThreadManagementError,
  ThreadManagementServiceShape,
} from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The project the thread lives in, or `fallback` when there is no such thread;
 * the project-scoped lookup that follows then reports it as not found.
 */
export const threadProjectId = (
  threads: Pick<ThreadManagementServiceShape, "getThreadShell">,
  threadId: ThreadId,
  fallback: ProjectId,
) =>
  threads.getThreadShell(threadId).pipe(
    Effect.map((shell) => shell?.projectId ?? fallback),
    Effect.orElseSucceed(() => fallback),
  );

/**
 * The threads t3_thread_list pages through: the calling project's by default,
 * another project's with `projectId`, every project's with scope "all". Same
 * order as `listProjectThreads`.
 */
export const listThreadsInScope = (
  threads: Pick<ThreadManagementServiceShape, "getShellSnapshot" | "listProjectThreads">,
  input: {
    readonly scope: "project" | "all" | undefined;
    readonly projectId: ProjectId;
    readonly includeSubagents: boolean;
  },
): Effect.Effect<
  ReadonlyArray<OrchestrationV2ThreadShell>,
  ThreadManagementError | OrchestratorV2Error
> =>
  input.scope !== "all"
    ? threads.listProjectThreads(input)
    : threads.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          snapshot.threads
            .filter((thread) => thread.deletedAt === null)
            .filter(
              (thread) =>
                input.includeSubagents || thread.lineage.relationshipToParent !== "subagent",
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
                right.id.localeCompare(left.id),
            ),
        ),
      );
