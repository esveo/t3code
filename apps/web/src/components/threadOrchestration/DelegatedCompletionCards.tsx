import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type {
  EnvironmentId,
  NodeId,
  OrchestrationV2Subagent,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type ChildThreadState,
  THREAD_UPDATE_TAG,
  type TaggedThreadMessage,
} from "@t3tools/shared/threadOrchestration";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { environmentThreadDetails } from "~/state/threads";
import { ThreadUpdateCard } from "./TaggedThreadMessage";

const STATE_OF_STATUS: Partial<Record<OrchestrationV2Subagent["status"], ChildThreadState>> = {
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

type TaskUpdate = TaggedThreadMessage;

function sameUpdates(left: ReadonlyArray<TaskUpdate>, right: ReadonlyArray<TaskUpdate>): boolean {
  return (
    left.length === right.length &&
    left.every(
      (update, index) =>
        update.threadId === right[index]!.threadId &&
        update.state === right[index]!.state &&
        update.title === right[index]!.title &&
        update.body === right[index]!.body,
    )
  );
}

/**
 * The finished tasks a wake reports, as update cards, read from the
 * coordinator's task records. Keyed by coordinator and task ids; it keeps its
 * previous value while nothing it shows changed, so streaming does not
 * re-render the cards.
 */
const taskUpdatesAtom = Atom.family((key: string) => {
  let previous: ReadonlyArray<TaskUpdate> = [];
  return Atom.make((get): ReadonlyArray<TaskUpdate> => {
    const [coordinatorKey = "", taskList = ""] = key.split("\u0001");
    const taskIds = taskList.split(",");
    const thread = get(environmentThreadDetails.threadAtom(parseThreadKey(coordinatorKey)));
    const tasks = thread?.projection.subagents ?? [];
    const next = taskIds.flatMap((taskId): TaskUpdate[] => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const state = task === undefined ? undefined : STATE_OF_STATUS[task.status];
      if (task === undefined || task.childThreadId === null || state === undefined) return [];
      return [
        {
          tag: THREAD_UPDATE_TAG,
          threadId: task.childThreadId,
          title: task.title?.trim() || task.prompt.trim().split("\n")[0] || "Delegated task",
          state,
          detail: DETAIL_OF_STATE[state] ?? null,
          answerId: null,
          body: task.result?.trim() || "(It gave no answer.)",
        },
      ];
    });
    if (!sameUpdates(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`fork-delegated-completion:${key}`));
});

const NO_UPDATES_ATOM = Atom.make<ReadonlyArray<TaskUpdate>>([]);

/**
 * Fork: V2 wakes a coordinator with a notification when its delegated tasks
 * finish; the wake carries their answers to the agent. Here the user sees
 * them too, one card per task with the child's chip and its full answer.
 */
export function DelegatedCompletionCards(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  taskIds: ReadonlyArray<NodeId>;
  markdownCwd: string | undefined;
}) {
  const updates = useAtomValue(
    props.threadRef
      ? taskUpdatesAtom(`${threadKey(props.threadRef)}\u0001${props.taskIds.join(",")}`)
      : NO_UPDATES_ATOM,
  );
  if (updates.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {updates.map((update) => (
        <ThreadUpdateCard
          key={update.threadId}
          update={update}
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          markdownCwd={props.markdownCwd}
          isLatest={false}
        />
      ))}
    </div>
  );
}
