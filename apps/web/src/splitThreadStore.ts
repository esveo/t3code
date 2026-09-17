import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";
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
  drag: SplitDragSource | null;
  setLayout: (layout: SplitNode) => void;
  setActiveLeaf: (leafId: string) => void;
  setDrag: (drag: SplitDragSource | null) => void;
}

export const useSplitThreadStore = create<SplitThreadStoreState>()(
  persist(
    (set) => ({
      layout: SINGLE_PANE_LAYOUT,
      activeLeafId: ROUTE_LEAF_ID,
      drag: null,
      setLayout: (layout) => set({ layout }),
      setActiveLeaf: (leafId) =>
        set((state) => (state.activeLeafId === leafId ? state : { activeLeafId: leafId })),
      setDrag: (drag) => set({ drag }),
    }),
    {
      name: "t3code:split-thread-state:v2",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => ({
        ...current,
        layout: sanitizeLayout((persisted as { layout?: SplitNode } | undefined)?.layout),
      }),
    },
  ),
);

/** The id of the pane a ChatView renders in. */
export const ChatPaneContext = createContext<string>(ROUTE_LEAF_ID);

/**
 * Whether the ChatView rendering this hook owns window-level input. Without a
 * split only the route pane exists, so it always does.
 */
export function useIsActiveChatPane(): boolean {
  const pane = useContext(ChatPaneContext);
  return useSplitThreadStore((state) =>
    state.layout.kind === "leaf" ? pane === ROUTE_LEAF_ID : state.activeLeafId === pane,
  );
}

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

function clearSidebarThreadDrag(): void {
  pendingPaneDrop = null;
  const { drag, setDrag } = useSplitThreadStore.getState();
  if (drag?.kind === "thread") setDrag(null);
}

/**
 * Sidebar hook: dnd-kit finished or cancelled the drag. Deferred, because the
 * sensor can report the finish before `onDragEnd` consumes the drop.
 */
export function endSidebarThreadDrag(): void {
  setTimeout(clearSidebarThreadDrag, 0);
}

/**
 * Sidebar hook: dnd-kit ended the drag. When it was released over a chat pane,
 * performs that drop and returns true so the sidebar skips its reorder.
 */
export function consumeSidebarThreadDrop(): boolean {
  const drop = pendingPaneDrop;
  clearSidebarThreadDrag();
  if (!drop) return false;
  drop();
  return true;
}
