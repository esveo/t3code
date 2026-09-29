/**
 * Fork: thread orchestration. The wake V2 sends a parent when its delegated
 * tasks end names only their ids and asks the agent to read each result with
 * task_status. Here the results travel with the wake instead, one
 * `<t3_thread_update>` block per task, in the same shape the coordinator gets
 * for later turns of its threads (CoordinatorUpdates.ts). The upstream text
 * stays first, so the wake still reads as one.
 */
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { type ChildThreadState, wrapThreadUpdate } from "@t3tools/shared/threadOrchestration";

type DelegatedTask = Pick<
  OrchestrationV2Subagent,
  "id" | "childThreadId" | "title" | "prompt" | "status" | "result"
>;

const STATE_OF_STATUS: Partial<Record<DelegatedTask["status"], ChildThreadState>> = {
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

const DETAIL_OF_STATE: Partial<Record<ChildThreadState, string>> = {
  done: "Finished",
  failed: "The task failed",
  stopped: "Stopped before it finished",
};

function taskTitle(task: DelegatedTask): string {
  const title = task.title?.trim() || task.prompt.trim().split("\n")[0] || "Delegated task";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

/** `detail`, then one update block per finished task with its full result. */
export function withDelegatedTaskResults(
  detail: string,
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<DelegatedTask>,
): string {
  const blocks = taskIds.flatMap((taskId) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    const state = task === undefined ? undefined : STATE_OF_STATUS[task.status];
    if (task === undefined || task.childThreadId === null || state === undefined) return [];
    return [
      wrapThreadUpdate({
        threadId: task.childThreadId,
        title: taskTitle(task),
        state,
        detail: DETAIL_OF_STATE[state] ?? "Finished",
        text: task.result?.trim() || "(It gave no answer.)",
      }),
    ];
  });
  return blocks.length === 0 ? detail : `${detail}\n\n${blocks.join("\n")}`;
}
