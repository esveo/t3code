import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveChildThreadState } from "@t3tools/shared/threadOrchestration";

/** Same key the sidebar uses for its rows. */
const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));

export interface ChildThreadGroups {
  /** Children under each coordinator, oldest first, keyed like `parentKeyOf`. */
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  /** Children that render under their coordinator instead of as their own rows. */
  readonly nestedThreadKeys: ReadonlySet<string>;
}

export function parentKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return keyOf(thread.environmentId, thread.id);
}

/**
 * A child nests under its coordinator while that coordinator is listed; a
 * child whose coordinator was archived or deleted stands on its own again, so
 * no thread ever disappears from the sidebar.
 */
export function groupChildThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ChildThreadGroups {
  const listed = new Set(
    threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => keyOf(thread.environmentId, thread.id)),
  );
  const childrenByParentKey = new Map<string, EnvironmentThreadShell[]>();
  const nestedThreadKeys = new Set<string>();
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt !== null) continue;
    const parentKey = keyOf(thread.environmentId, thread.parentThreadId);
    if (!listed.has(parentKey)) continue;
    const group = childrenByParentKey.get(parentKey);
    if (group) group.push(thread);
    else childrenByParentKey.set(parentKey, [thread]);
    nestedThreadKeys.add(keyOf(thread.environmentId, thread.id));
  }
  for (const group of childrenByParentKey.values()) {
    group.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return { childrenByParentKey, nestedThreadKeys };
}

export interface ChildThreadCounts {
  readonly total: number;
  readonly waiting: number;
  readonly working: number;
}

export function countChildThreads(
  children: ReadonlyArray<EnvironmentThreadShell>,
): ChildThreadCounts {
  let waiting = 0;
  let working = 0;
  for (const child of children) {
    const state = resolveChildThreadState(child);
    if (state === "waiting" || state === "failed") waiting += 1;
    else if (state === "working") working += 1;
  }
  return { total: children.length, waiting, working };
}

/** Folded groups still show the children that need the user, and the open one. */
export function visibleChildThreads(input: {
  readonly children: ReadonlyArray<EnvironmentThreadShell>;
  readonly collapsed: boolean;
  readonly openThreadKey: string | null;
}): ReadonlyArray<EnvironmentThreadShell> {
  if (!input.collapsed) return input.children;
  return input.children.filter((child) => {
    const state = resolveChildThreadState(child);
    return (
      state === "waiting" ||
      state === "failed" ||
      keyOf(child.environmentId, child.id) === input.openThreadKey
    );
  });
}
