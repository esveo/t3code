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

/** Which part of the sidebar a thread lists in: open, snoozed or settled. */
export type SidebarShelf = "open" | "snoozed" | "settled";

export function sidebarShelfOf(
  thread: Pick<EnvironmentThreadShell, "settledOverride" | "snoozedUntil">,
  now: string,
): SidebarShelf {
  // Mirrors the sidebar's own sections: snooze outranks settlement.
  if (thread.snoozedUntil != null && thread.snoozedUntil > now) return "snoozed";
  return thread.settledOverride === "settled" ? "settled" : "open";
}

/**
 * A child nests under its coordinator while that coordinator is listed on the
 * same shelf: a settled child leaves an open coordinator's group for the
 * settled shelf, and comes back with it. A child whose coordinator was
 * archived or deleted stands on its own again, so no thread ever disappears
 * from the sidebar.
 */
export function groupChildThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string = new Date().toISOString(),
): ChildThreadGroups {
  const shelfByKey = new Map(
    threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => [keyOf(thread.environmentId, thread.id), sidebarShelfOf(thread, now)]),
  );
  const childrenByParentKey = new Map<string, EnvironmentThreadShell[]>();
  const nestedThreadKeys = new Set<string>();
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt !== null) continue;
    const parentKey = keyOf(thread.environmentId, thread.parentThreadId);
    const parentShelf = shelfByKey.get(parentKey);
    if (parentShelf === undefined || parentShelf !== sidebarShelfOf(thread, now)) continue;
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

/** Run key of the sidebar's "Cross-project" group; no project key can take this form. */
export const CROSS_PROJECT_RUN_KEY = "\u0001cross-project";

/**
 * Coordinators whose work spans projects: they and their children cover more
 * than one project. With the sidebar grouped by project they leave their
 * project's run for the "Cross-project" group, since no single project owns
 * the work any more.
 */
export function crossProjectCoordinatorKeys(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly groups: ChildThreadGroups;
}): ReadonlySet<string> {
  const byKey = new Map(
    input.threads.map((thread) => [keyOf(thread.environmentId, thread.id), thread]),
  );
  const keys = new Set<string>();
  for (const [parentKey, children] of input.groups.childrenByParentKey) {
    const parent = byKey.get(parentKey);
    if (!parent) continue;
    const projects = new Set([parent.projectId, ...children.map((child) => child.projectId)]);
    if (projects.size > 1) keys.add(parentKey);
  }
  return keys;
}
