import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { CoordinatorOf } from "./childThreads.logic";
import {
  type ChildThreadState,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";

export type ThreadOverviewGroupId = "waiting" | "working" | "review" | "active" | "settled";

export interface ThreadOverviewGroup {
  readonly id: ThreadOverviewGroupId;
  readonly label: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

const GROUP_OF_STATE: Record<ChildThreadState, ThreadOverviewGroupId | "done"> = {
  waiting: "waiting",
  failed: "waiting",
  working: "working",
  review: "review",
  stopped: "done",
  done: "done",
};

/** Finished threads split like the sidebar does: still active, or settled. */
function groupOf(child: EnvironmentThreadShell): ThreadOverviewGroupId {
  const group = GROUP_OF_STATE[resolveChildThreadState(child.source)];
  if (group !== "done") return group;
  return child.settledOverride === "settled" ? "settled" : "active";
}

const GROUPS: ReadonlyArray<{ readonly id: ThreadOverviewGroupId; readonly label: string }> = [
  { id: "waiting", label: "Waiting on you" },
  { id: "working", label: "Working" },
  { id: "review", label: "Ready for review" },
  { id: "active", label: "Active" },
  { id: "settled", label: "Settled" },
];

/** The children of one coordinator. */
export function childThreadsOf(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  coordinator: Pick<EnvironmentThreadShell, "environmentId" | "id">,
  coordinatorOf: CoordinatorOf,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.environmentId === coordinator.environmentId &&
      thread.archivedAt === null &&
      coordinatorOf(thread) === coordinator.id,
  );
}

/**
 * The overview's sections in the order the user acts on them: what blocks on
 * them first (a failure counts, it needs a decision), then running work, then
 * finished work waiting for review, then the rest: active before settled. Newest activity first
 * within a section; empty sections are left out.
 */
export function buildThreadOverview(
  children: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ThreadOverviewGroup> {
  const byGroup = new Map<ThreadOverviewGroupId, EnvironmentThreadShell[]>();
  for (const child of children) {
    const group = groupOf(child);
    const list = byGroup.get(group);
    if (list) list.push(child);
    else byGroup.set(group, [child]);
  }
  return GROUPS.flatMap((group) => {
    const threads = byGroup.get(group.id);
    if (!threads) return [];
    threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return [{ ...group, threads }];
  });
}

export function waitingThreadCount(children: ReadonlyArray<EnvironmentThreadShell>): number {
  return children.filter((child) => groupOf(child) === "waiting").length;
}
