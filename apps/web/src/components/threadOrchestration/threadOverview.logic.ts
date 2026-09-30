import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";

import type { CoordinatorOf } from "./childThreads.logic";
import {
  type ChildThreadState,
  describeChildThread,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";

export type ThreadOverviewGroupId = "waiting" | "working" | "review" | "active" | "settled";

/** A child thread the coordinator started, or a subagent its provider started. */
export type ThreadOverviewKind = "thread" | "subagent";

export interface ThreadOverviewEntry {
  readonly kind: ThreadOverviewKind;
  readonly thread: EnvironmentThreadShell;
  readonly state: ChildThreadState;
  /** One line on what it is doing or needs, next to its state. */
  readonly detail: string;
  readonly updatedAt: string;
}

export interface ThreadOverviewGroup {
  readonly id: ThreadOverviewGroupId;
  readonly label: string;
  readonly entries: ReadonlyArray<ThreadOverviewEntry>;
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
function groupOf(entry: ThreadOverviewEntry): ThreadOverviewGroupId {
  const group = GROUP_OF_STATE[entry.state];
  if (group !== "done") return group;
  return entry.thread.settledOverride === "settled" ? "settled" : "active";
}

const GROUPS: ReadonlyArray<{ readonly id: ThreadOverviewGroupId; readonly label: string }> = [
  { id: "waiting", label: "Waiting on you" },
  { id: "review", label: "Ready for review" },
  { id: "working", label: "Working" },
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
 * The provider-native subagents the thread's agent started, by their own
 * threads. One handed to a coordinator through a link lists there instead.
 */
export function subagentThreadsOf(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  parent: Pick<EnvironmentThreadShell, "environmentId" | "id">,
  coordinatorOf: CoordinatorOf,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.environmentId === parent.environmentId &&
      thread.archivedAt === null &&
      thread.lineage.parentThreadId === parent.id &&
      isProviderNativeSubagentThread(thread.source) &&
      coordinatorOf(thread) === null,
  );
}

/** What the parent's projection knows about a subagent, by its thread. */
export interface SubagentSnapshot {
  readonly status: OrchestrationV2Subagent["status"];
  readonly updatedAt: string;
}

/**
 * A subagent's thread has no runs of its own, so its shell reads idle; its
 * status lives on the parent's subagent record. A request pending on the
 * subagent's thread still wins, as it does for any thread.
 */
function subagentState(
  thread: EnvironmentThreadShell,
  snapshot: SubagentSnapshot | undefined,
): Pick<ThreadOverviewEntry, "state" | "detail"> {
  if (snapshot === undefined || thread.source.pendingRuntimeRequest !== null) {
    return {
      state: resolveChildThreadState(thread.source),
      detail: describeChildThread(thread.source),
    };
  }
  switch (snapshot.status) {
    case "pending":
    case "running":
      return { state: "working", detail: "Working" };
    case "waiting":
      return { state: "waiting", detail: "Needs your input" };
    case "failed":
      return { state: "failed", detail: "The subagent failed" };
    case "interrupted":
    case "cancelled":
      return { state: "stopped", detail: "Stopped before it finished" };
    case "idle":
    case "completed":
      return { state: "done", detail: "Finished" };
  }
}

/** Child threads and subagents as one list; a thread listed as a child is not listed again. */
export function threadOverviewEntries(input: {
  readonly children: ReadonlyArray<EnvironmentThreadShell>;
  readonly subagentThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly subagents: ReadonlyMap<ThreadId, SubagentSnapshot>;
}): ReadonlyArray<ThreadOverviewEntry> {
  const childIds = new Set(input.children.map((child) => child.id));
  return [
    ...input.children.map((thread): ThreadOverviewEntry => ({
      kind: "thread",
      thread,
      state: resolveChildThreadState(thread.source),
      detail: describeChildThread(thread.source),
      updatedAt: thread.updatedAt,
    })),
    ...input.subagentThreads
      .filter((thread) => !childIds.has(thread.id))
      .map((thread): ThreadOverviewEntry => {
        const snapshot = input.subagents.get(thread.id);
        const updatedAt =
          snapshot !== undefined && snapshot.updatedAt > thread.updatedAt
            ? snapshot.updatedAt
            : thread.updatedAt;
        return { kind: "subagent", thread, ...subagentState(thread, snapshot), updatedAt };
      }),
  ];
}

/**
 * The overview's sections in the order the user acts on them: what blocks on
 * them first (a failure counts, it needs a decision), then running work, then
 * finished work waiting for review, then the rest: active before settled. Newest activity first
 * within a section; empty sections are left out.
 */
export function buildThreadOverview(
  entries: ReadonlyArray<ThreadOverviewEntry>,
): ReadonlyArray<ThreadOverviewGroup> {
  const byGroup = new Map<ThreadOverviewGroupId, ThreadOverviewEntry[]>();
  for (const entry of entries) {
    const group = groupOf(entry);
    const list = byGroup.get(group);
    if (list) list.push(entry);
    else byGroup.set(group, [entry]);
  }
  return GROUPS.flatMap((group) => {
    const list = byGroup.get(group.id);
    if (!list) return [];
    list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return [{ ...group, entries: list }];
  });
}

export function waitingEntries(
  entries: ReadonlyArray<ThreadOverviewEntry>,
): ReadonlyArray<ThreadOverviewEntry> {
  return entries.filter((entry) => groupOf(entry) === "waiting");
}

export function waitingThreadCount(entries: ReadonlyArray<ThreadOverviewEntry>): number {
  return waitingEntries(entries).length;
}

/** "2 threads", "1 subagent", "2 threads and 1 subagent". */
export function countOverviewEntries(entries: ReadonlyArray<ThreadOverviewEntry>): string {
  const threads = entries.filter((entry) => entry.kind === "thread").length;
  const subagents = entries.length - threads;
  const parts = [
    threads > 0 ? `${threads} thread${threads === 1 ? "" : "s"}` : null,
    subagents > 0 ? `${subagents} subagent${subagents === 1 ? "" : "s"}` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" and ") : "0 threads";
}

/** The panel's subline: coordinated threads, and subagents the agent started. */
export function describeOverviewOrigin(entries: ReadonlyArray<ThreadOverviewEntry>): string {
  const count = countOverviewEntries(entries);
  return entries.some((entry) => entry.kind === "subagent")
    ? `${count} started from here`
    : `${count} coordinated from here`;
}
