import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { describeChildThread } from "@t3tools/shared/threadOrchestration";
import { useMemo } from "react";

import { useThreadShells } from "~/state/entities";
import { useCoordinatorOf } from "../threadOrchestration/coordinatorLinks";
import { childThreadsOf } from "../threadOrchestration/threadOverview.logic";
import { ThreadLinkChip } from "../threadOrchestration/ThreadLinkChip";
import { useOpenThread } from "../threadOrchestration/useOpenThread";

/** The coordinator's threads that wait on an approval or answer from the user, oldest first. */
export function childrenWaitingOnUser(
  children: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return children
    .filter((child) => child.source.pendingRuntimeRequest !== null)
    .toSorted(
      (left, right) =>
        (left.source.pendingRuntimeRequest?.createdAt.epochMilliseconds ?? 0) -
        (right.source.pendingRuntimeRequest?.createdAt.epochMilliseconds ?? 0),
    );
}

export function useChildrenWaitingOnUser(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useThreadShells();
  const coordinatorOf = useCoordinatorOf(threads);
  return useMemo(
    () =>
      threadRef
        ? childrenWaitingOnUser(
            childThreadsOf(
              threads,
              { environmentId: threadRef.environmentId, id: threadRef.threadId },
              coordinatorOf,
            ),
          )
        : [],
    [coordinatorOf, threadRef, threads],
  );
}

/**
 * Fork: approvals and questions the coordinator's threads have for the user.
 * They are answered in the thread itself, so each row opens it.
 */
export function ChildRequestsSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const waiting = useChildrenWaitingOnUser(threadRef);
  const openThread = useOpenThread();
  if (waiting.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5">
      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Threads waiting on you</p>
      {waiting.map((child) => (
        <button
          key={child.id}
          type="button"
          onClick={() => openThread(scopeThreadRef(child.environmentId, child.id))}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
        >
          <ThreadLinkChip
            environmentId={child.environmentId}
            threadId={child.id}
            label={child.title}
          />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {describeChildThread(child.source)}
          </span>
        </button>
      ))}
    </section>
  );
}
