import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  ROUTE_LEAF_ID,
  sanitizeLayout,
  SINGLE_PANE_LAYOUT,
  type SplitNode,
} from "./components/split/splitLayout.logic";
import { resolveStorage } from "./lib/storage";

/**
 * Split view: chat panes arranged like VS Code editor groups. The layout lives
 * in a store rather than in the URL so ordinary thread navigation (which drops
 * search params) keeps the other panes open.
 */

/** What is being dragged onto the chat panes. */
export type SplitDragSource =
  | { readonly kind: "thread"; readonly thread: ScopedThreadRef; readonly title: string }
  | { readonly kind: "leaf"; readonly leafId: string; readonly title: string };

interface SplitThreadStoreState {
  layout: SplitNode;
  /** The pane that owns window-level shortcuts, paste and type-to-focus. */
  activeLeafId: string;
  /**
   * The thread the route pane shows. Persisted with the layout because the
   * route pane follows the URL: after a restart the app decides where to land,
   * and without this the thread that pane was showing would be gone.
   */
  routeThread: ScopedThreadRef | null;
  drag: SplitDragSource | null;
  setLayout: (layout: SplitNode) => void;
  setActiveLeaf: (leafId: string) => void;
  setRouteThread: (thread: ScopedThreadRef | null) => void;
  setDrag: (drag: SplitDragSource | null) => void;
}

export const useSplitThreadStore = create<SplitThreadStoreState>()(
  persist(
    (set) => ({
      layout: SINGLE_PANE_LAYOUT,
      activeLeafId: ROUTE_LEAF_ID,
      routeThread: null,
      drag: null,
      setLayout: (layout) => set({ layout }),
      setActiveLeaf: (leafId) =>
        set((state) => (state.activeLeafId === leafId ? state : { activeLeafId: leafId })),
      setRouteThread: (thread) =>
        set((state) =>
          state.routeThread?.environmentId === thread?.environmentId &&
          state.routeThread?.threadId === thread?.threadId
            ? state
            : { routeThread: thread },
        ),
      setDrag: (drag) => set({ drag }),
    }),
    {
      name: "t3code:split-thread-state:v2",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ layout: state.layout, routeThread: state.routeThread }),
      merge: (persisted, current) => {
        const stored = persisted as
          | { layout?: SplitNode; routeThread?: ScopedThreadRef | null }
          | undefined;
        const routeThread = stored?.routeThread;
        return {
          ...current,
          layout: sanitizeLayout(stored?.layout),
          routeThread:
            routeThread && routeThread.environmentId && routeThread.threadId ? routeThread : null,
        };
      },
    },
  ),
);

// The drop a sidebar thread drag would perform if released now: set while the
// pointer is over a chat pane. The sidebar runs it when dnd-kit ends the drag.
let pendingPaneDrop: (() => void) | null = null;

export function setPendingPaneDrop(drop: (() => void) | null): void {
  pendingPaneDrop = drop;
}

/** Sidebar hook: a thread drag started and may end on a chat pane. */
export function startSidebarThreadDrag(thread: ScopedThreadRef, title: string): void {
  pendingPaneDrop = null;
  useSplitThreadStore.getState().setDrag({ kind: "thread", thread, title });
}

function clearThreadDragOverlay(): void {
  const { drag, setDrag } = useSplitThreadStore.getState();
  if (drag?.kind === "thread") setDrag(null);
}

/**
 * Sidebar hook: dnd-kit finished or cancelled the drag. Only the overlay goes,
 * and deferred at that, because the sensor reports the finish before
 * `onDragEnd` runs. The pending drop outlives it on purpose: dropping it here
 * raced `onDragEnd`, and a release over a pane sometimes did nothing. It is
 * replaced when the next drag starts and dropped when Escape cancels one.
 */
export function endSidebarThreadDrag(): void {
  setTimeout(clearThreadDragOverlay, 0);
}

/**
 * Sidebar hook: dnd-kit ended the drag. When it was released over a chat pane,
 * performs that drop and returns true so the sidebar skips its reorder.
 */
export function consumeSidebarThreadDrop(): boolean {
  const drop = pendingPaneDrop;
  pendingPaneDrop = null;
  clearThreadDragOverlay();
  if (!drop) return false;
  drop();
  return true;
}
