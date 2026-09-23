import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell, useThreadShells } from "~/state/entities";
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
  const children = useMemo(
    () =>
      threadRef
        ? childThreadsOf(threads, {
            environmentId: threadRef.environmentId,
            id: threadRef.threadId,
          })
        : [],
    [threadRef, threads],
  );
  const available =
    threadRef !== null && (children.length > 0 || (enabled && !thread?.parentThreadId));
  const open = useCallback(() => {
    if (!threadRef || !available) return;
    useRightPanelStore.getState().open(threadRef, "thread-overview");
  }, [available, threadRef]);
  return { available, waitingCount: waitingThreadCount(children), open };
}

/** Whether a thread has started any threads, for chrome that only shows then. */
export function useHasChildThreads(threadRef: ScopedThreadRef | null): boolean {
  const threads = useThreadShells();
  return useMemo(
    () =>
      threadRef !== null &&
      childThreadsOf(threads, { environmentId: threadRef.environmentId, id: threadRef.threadId })
        .length > 0,
    [threadRef, threads],
  );
}
