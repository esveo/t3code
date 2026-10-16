/**
 * Fork: an automation bound to a thread can run each trigger as a subthread
 * of it (`spawnAsSubthread`) instead of posting its prompt there.
 *
 * The run launches a new thread with the prompt and puts it under the bound
 * thread before it exists, as `t3_thread_launch` with `coordinate: true` does.
 * The bound thread gets no message and no turn when the run starts; the
 * child's result reaches it later as a coordinator update
 * (threadOrchestration/CoordinatorUpdates.ts). V2's own delegated tasks
 * cannot carry this: they hang off an active run of the parent, and a bound
 * thread is usually idle when its automation fires.
 */
import {
  type CommandId,
  type MessageId,
  type ScheduledTask,
  ScheduledTaskError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { ThreadCoordinators } from "../threadOrchestration/ThreadCoordinators.ts";

/** Whether a saved task runs as subthreads; only a thread-bound task can. */
export function spawnsAsSubthread(
  task: Pick<ScheduledTask, "threadId" | "spawnAsSubthread">,
): boolean {
  return task.threadId !== null && task.spawnAsSubthread === true;
}

/** The setting to save: an omitted value keeps the stored one, unbound tasks never have it. */
export function resolveSpawnAsSubthread(
  input: {
    readonly threadId?: string | null | undefined;
    readonly spawnAsSubthread?: boolean | undefined;
  },
  existing: Pick<ScheduledTask, "spawnAsSubthread"> | null,
): boolean {
  if (input.threadId == null) return false;
  return input.spawnAsSubthread ?? existing?.spawnAsSubthread ?? false;
}

export const launchScheduledSubthread = (
  services: {
    readonly threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"];
    readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
    readonly coordinators: Option.Option<ThreadCoordinators["Service"]>;
  },
  input: {
    readonly task: ScheduledTask;
    /** The bound thread. */
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly prompt: string;
  },
) =>
  Effect.gen(function* () {
    const { task } = input;
    if (Option.isNone(services.coordinators)) {
      return yield* new ScheduledTaskError({
        message: "This server cannot run automations as subthreads.",
        taskId: task.id,
      });
    }
    const coordinators = services.coordinators.value;
    // Fails like a plain bound run when the thread is gone.
    const parent = yield* services.threadManagement.getProjectThreadRecords(
      { projectId: task.projectId, threadId: input.threadId },
      [],
    );
    if (parent.thread.archivedAt !== null) {
      return yield* new ScheduledTaskError({
        message: `'${parent.thread.title}' is archived.`,
        taskId: task.id,
      });
    }
    // Derived from the run's command id, so a replayed run claims and
    // launches the same thread instead of a second one.
    const threadId = ThreadId.make(input.commandId);
    yield* coordinators.claim({ threadId, coordinatorThreadId: parent.thread.id });
    return yield* services.threadLaunch
      .launch({
        commandId: input.commandId,
        threadId,
        projectId: parent.thread.projectId,
        title: task.title,
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
        // The parent's checkout, never a worktree of its own.
        workspaceStrategy:
          parent.thread.worktreePath === null
            ? { type: "root" }
            : {
                type: "existing_worktree",
                worktreePath: parent.thread.worktreePath,
                ...(parent.thread.branch === null ? {} : { branch: parent.thread.branch }),
              },
        initialMessage: {
          messageId: input.messageId,
          scheduledTaskId: task.id,
          text: input.prompt,
          attachments: [],
        },
        createdBy: task.createdBy,
        creationSource: task.creationSource,
      })
      .pipe(Effect.tapError(() => coordinators.unclaim(threadId).pipe(Effect.ignore)));
  });
