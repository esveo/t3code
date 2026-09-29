import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type ContextMenuItem,
  isProviderNativeSubagentThread,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Fork: thread orchestration. An existing thread can be put under a
 * coordinator after the fact, so the coordinator reads, messages and follows
 * it like a thread it started. The server enforces the same rules
 * (apps/server/src/threadOrchestration/ThreadCoordinators.ts); these only keep
 * the menu and the picker from offering what it would reject.
 */
export type ThreadParentMenuId = "assign-parent" | "detach-parent";

type ParentShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "archivedAt" | "updatedAt" | "source"
>;
type CoordinatorOf = (thread: ParentShell) => ThreadId | null;

/** Whether the thread coordinates threads of its own, which keeps it from becoming a child. */
export function hasChildThreads(
  threads: ReadonlyArray<ParentShell>,
  thread: Pick<ParentShell, "environmentId" | "id">,
  coordinatorOf: CoordinatorOf,
): boolean {
  return threads.some(
    (candidate) =>
      candidate.environmentId === thread.environmentId && coordinatorOf(candidate) === thread.id,
  );
}

/**
 * Threads the given one can move under: open threads of its environment that
 * are not children themselves, current coordinators first, then the most
 * recently updated. Any project, as a coordinator starts threads anywhere.
 * Provider subagents are left out: their provider steers them.
 */
export function parentThreadCandidates<T extends ParentShell>(
  threads: ReadonlyArray<T>,
  thread: ParentShell,
  coordinatorOf: CoordinatorOf,
): ReadonlyArray<T> {
  if (hasChildThreads(threads, thread, coordinatorOf)) return [];
  const current = coordinatorOf(thread);
  const coordinatorIds = new Set(
    threads
      .filter((candidate) => candidate.environmentId === thread.environmentId)
      .flatMap((candidate) => {
        const coordinatorId = coordinatorOf(candidate);
        return coordinatorId ? [coordinatorId] : [];
      }),
  );
  return threads
    .filter(
      (candidate) =>
        candidate.environmentId === thread.environmentId &&
        candidate.id !== thread.id &&
        candidate.id !== current &&
        candidate.archivedAt === null &&
        !isProviderNativeSubagentThread(candidate.source) &&
        coordinatorOf(candidate) === null,
    )
    .toSorted(
      (left, right) =>
        Number(coordinatorIds.has(right.id)) - Number(coordinatorIds.has(left.id)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
}

/** The thread menu's coordinator items, before the Copy group. */
export function withThreadParentMenuItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  state: {
    readonly hasParent: boolean;
    readonly hasChildren: boolean;
  },
): ReadonlyArray<ContextMenuItem<Id | ThreadParentMenuId>> {
  const added: ContextMenuItem<ThreadParentMenuId>[] = [];
  if (!state.hasChildren) {
    added.push({
      id: "assign-parent",
      label: state.hasParent ? "Move to another coordinator…" : "Assign to coordinator…",
      icon: "folder-tree",
    });
  }
  if (state.hasParent) {
    added.push({ id: "detach-parent", label: "Detach from coordinator", icon: "pin-off" });
  }
  if (added.length === 0) return items;
  const copyIndex = items.findIndex((item) => item.id === "copy");
  const at = copyIndex === -1 ? items.length : copyIndex;
  return [...items.slice(0, at), ...added, ...items.slice(at)];
}
