import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { waitingDescendantsByThread } from "@t3tools/shared/threadOrchestration";

import type { SidebarThreadStatus } from "../Sidebar.logic";

const SEPARATOR = "\u0000";
const NO_OVERRIDES: ReadonlyMap<ThreadId, ThreadId | null> = new Map();

export const waitingForYouKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}${SEPARATOR}${threadId}`;

/**
 * Fork: for each thread with threads below it whose request waits on the user,
 * their ids oldest first, joined, by `waitingForYouKey`. A string keeps a row's
 * value equal, and the row still, while other threads change.
 */
export function waitingForYouIndex(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overridesByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, ThreadId | null>>,
): ReadonlyMap<string, string> {
  const byEnvironment = new Map<EnvironmentId, Array<EnvironmentThreadShell["source"]>>();
  for (const thread of threads) {
    const shells = byEnvironment.get(thread.environmentId) ?? [];
    shells.push(thread.source);
    byEnvironment.set(thread.environmentId, shells);
  }
  const index = new Map<string, string>();
  for (const [environmentId, shells] of byEnvironment) {
    if (!shells.some((shell) => shell.pendingRuntimeRequest !== null)) continue;
    const waiting = waitingDescendantsByThread(
      shells,
      overridesByEnvironment.get(environmentId) ?? NO_OVERRIDES,
    );
    for (const [threadId, descendants] of waiting) {
      index.set(
        waitingForYouKey(environmentId, threadId),
        descendants.map((descendant) => descendant.id).join(SEPARATOR),
      );
    }
  }
  return index;
}

export const waitingThreadIdsOf = (joined: string): ReadonlyArray<ThreadId> =>
  joined === "" ? [] : (joined.split(SEPARATOR) as Array<ThreadId>);

/** A descendant's request outranks the thread's own work, not its own request or failure. */
export function withWaitingForYou(
  status: SidebarThreadStatus,
  waitingThreadIds: ReadonlyArray<ThreadId>,
): SidebarThreadStatus {
  if (waitingThreadIds.length === 0) return status;
  return status === "preparing" ||
    status === "working" ||
    status === "waiting" ||
    status === "ready"
    ? "input"
    : status;
}
