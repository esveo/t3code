import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell, useThreadShells } from "~/state/entities";
import { useCoordinatorOf } from "./coordinatorLinks";
import { childThreadsOf, waitingThreadCount } from "./threadOverview.logic";

/**
 * Fork: whether the thread overview can open for this thread, how many of its
 * threads wait on the user, and the opener. Any thread that does not report
 * to a coordinator has it, empty until it has threads.
 */
export function useThreadOverviewSurface(threadRef: ScopedThreadRef | null) {
  const threads = useThreadShells();
  const thread = useThreadShell(threadRef);
  const coordinatorOf = useCoordinatorOf(threads);
  const children = useMemo(
    () =>
      threadRef
        ? childThreadsOf(
            threads,
            { environmentId: threadRef.environmentId, id: threadRef.threadId },
            coordinatorOf,
          )
        : [],
    [coordinatorOf, threadRef, threads],
  );
  const available =
    threadRef !== null &&
    (children.length > 0 || (thread !== null && coordinatorOf(thread) === null));
  const open = useCallback(() => {
    if (!threadRef || !available) return;
    useRightPanelStore.getState().open(threadRef, "thread-overview");
  }, [available, threadRef]);
  return { available, waitingCount: waitingThreadCount(children), open };
}
