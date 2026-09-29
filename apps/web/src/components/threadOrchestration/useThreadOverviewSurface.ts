import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell, useThreadShells } from "~/state/entities";
import { useCoordinatorOf } from "./coordinatorLinks";
import { childThreadsOf, waitingThreadCount } from "./threadOverview.logic";

/**
 * Fork: whether the thread overview can open for this thread, how many of its
 * threads wait on the user, and the opener. A thread that started threads
 * always has it; with orchestration on, any coordinator can open it empty.
 */
export function useThreadOverviewSurface(threadRef: ScopedThreadRef | null) {
  const threads = useThreadShells();
  const thread = useThreadShell(threadRef);
  const enabled = useEnvironmentSettings(
    threadRef?.environmentId ?? ("" as ScopedThreadRef["environmentId"]),
    (settings) => settings.enableThreadOrchestration,
  );
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
    (children.length > 0 || (enabled && thread !== null && coordinatorOf(thread) === null));
  const open = useCallback(() => {
    if (!threadRef || !available) return;
    useRightPanelStore.getState().open(threadRef, "thread-overview");
  }, [available, threadRef]);
  return { available, waitingCount: waitingThreadCount(children), open };
}
