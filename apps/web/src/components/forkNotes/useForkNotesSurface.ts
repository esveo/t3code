import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { openTodoCount } from "./forkNotesLogic";
import { forkNotesEnvironment } from "./forkNotesState";

export interface ForkNotesSurfaceProps {
  readonly available: boolean;
  /** Open todos of the thread's own list, shown on the tab. */
  readonly openCount: number;
  readonly open: () => void;
}

export const UNAVAILABLE_FORK_NOTES: ForkNotesSurfaceProps = {
  available: false,
  openCount: 0,
  open: () => {},
};

/**
 * Fork: whether the Notes tab can open for this thread and the count its tab
 * shows. The thread's list is only subscribed while the thread has the tab.
 */
export function useForkNotesSurface(threadRef: ScopedThreadRef | null): ForkNotesSurfaceProps {
  const hasTab = useRightPanelStore((state) =>
    threadRef
      ? (state.byThreadKey[scopedThreadKey(threadRef)]?.surfaces.some(
          (surface) => surface.kind === "notes",
        ) ?? false)
      : false,
  );
  const query = useEnvironmentQuery(
    hasTab && threadRef
      ? forkNotesEnvironment.notes({
          environmentId: threadRef.environmentId,
          input: { scope: "thread", scopeId: threadRef.threadId },
        })
      : null,
  );
  const open = useCallback(() => {
    if (threadRef) useRightPanelStore.getState().open(threadRef, "notes");
  }, [threadRef]);
  return {
    available: threadRef !== null,
    openCount: query.data ? openTodoCount(query.data.notes) : 0,
    open,
  };
}
