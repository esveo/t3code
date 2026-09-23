import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type ChildThreadState,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";

export type ThreadOverviewGroupId = "waiting" | "working" | "review" | "done";

export interface ThreadOverviewGroup {
  readonly id: ThreadOverviewGroupId;
  readonly label: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

const GROUP_OF_STATE: Record<ChildThreadState, ThreadOverviewGroupId> = {
  waiting: "waiting",
  failed: "waiting",
  working: "working",
  review: "review",
  stopped: "done",
  done: "done",
};

const GROUPS: ReadonlyArray<{ readonly id: ThreadOverviewGroupId; readonly label: string }> = [
  { id: "waiting", label: "Waiting on you" },
  { id: "working", label: "Working" },
  { id: "review", label: "Ready for review" },
  { id: "done", label: "Done" },
];

/** The children of one coordinator. */
export function childThreadsOf(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  coordinator: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.environmentId === coordinator.environmentId &&
      thread.parentThreadId === coordinator.id &&
      thread.archivedAt === null,
  );
}

/**
 * The overview's sections in the order the user acts on them: what blocks on
 * them first (a failure counts, it needs a decision), then running work, then
 * finished work waiting for review, then the rest. Newest activity first
 * within a section; empty sections are left out.
 */
export function buildThreadOverview(
  children: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ThreadOverviewGroup> {
  const byGroup = new Map<ThreadOverviewGroupId, EnvironmentThreadShell[]>();
  for (const child of children) {
    const group = GROUP_OF_STATE[resolveChildThreadState(child)];
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
  return children.filter((child) => GROUP_OF_STATE[resolveChildThreadState(child)] === "waiting")
    .length;
}
