import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Split view: a second thread shown beside the routed one. The beside thread
 * lives in a store rather than in the URL so ordinary thread navigation (which
 * drops search params) keeps the split open.
 */
export type ChatPane = "primary" | "beside";

export const SPLIT_BESIDE_MIN_RATIO = 0.25;
export const SPLIT_BESIDE_MAX_RATIO = 0.75;
const SPLIT_BESIDE_DEFAULT_RATIO = 0.5;

interface SplitThreadStoreState {
  besideThreadRef: ScopedThreadRef | null;
  /** Share of the chat area taken by the beside pane. */
  besideRatio: number;
  /** The pane that owns window-level shortcuts, paste and type-to-focus. */
  activePane: ChatPane;
  openBeside: (ref: ScopedThreadRef) => void;
  closeBeside: () => void;
  setActivePane: (pane: ChatPane) => void;
  setBesideRatio: (ratio: number) => void;
}

export const useSplitThreadStore = create<SplitThreadStoreState>()(
  persist(
    (set) => ({
      besideThreadRef: null,
      besideRatio: SPLIT_BESIDE_DEFAULT_RATIO,
      activePane: "primary",
      openBeside: (ref) =>
        set({
          besideThreadRef: { environmentId: ref.environmentId, threadId: ref.threadId },
          activePane: "beside",
        }),
      closeBeside: () => set({ besideThreadRef: null, activePane: "primary" }),
      setActivePane: (pane) =>
        set((state) => (state.activePane === pane ? state : { activePane: pane })),
      setBesideRatio: (ratio) =>
        set({
          besideRatio: Math.min(SPLIT_BESIDE_MAX_RATIO, Math.max(SPLIT_BESIDE_MIN_RATIO, ratio)),
        }),
    }),
    {
      name: "t3code:split-thread-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        besideThreadRef: state.besideThreadRef,
        besideRatio: state.besideRatio,
      }),
    },
  ),
);

export function isSameThreadRef(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) return false;
  return scopedThreadKey(left) === scopedThreadKey(right);
}

export const ChatPaneContext = createContext<ChatPane>("primary");

/**
 * Whether the ChatView rendering this hook owns window-level input. Without a
 * split only the primary pane exists, so it always does.
 */
export function useIsActiveChatPane(): boolean {
  const pane = useContext(ChatPaneContext);
  return useSplitThreadStore((state) =>
    state.besideThreadRef === null ? pane === "primary" : state.activePane === pane,
  );
}
