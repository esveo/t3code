import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { ROUTE_LEAF_ID } from "../components/split/splitLayout.logic";
import { resolveStorage } from "../lib/storage";
import { useSplitThreadStore } from "../splitThreadStore";

/**
 * Agent stage: a visual mode that draws the running agents as sprites moving
 * between the kinds of work they do. The setting is persisted; which panes
 * currently show the stage and which agent each pane follows are session
 * state, keyed by chat pane because the stage is a way of looking at a pane,
 * not a property of the thread.
 */
interface AgentStageStoreState {
  /** The setting: whether the stage can be opened at all. */
  enabled: boolean;
  openByPane: Record<string, true>;
  selectedByPane: Record<string, string>;
  setEnabled: (enabled: boolean) => void;
  toggleOpen: (paneId: string) => void;
  setOpen: (paneId: string, open: boolean) => void;
  select: (paneId: string, agentId: string) => void;
}

export const useAgentStageStore = create<AgentStageStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      openByPane: {},
      selectedByPane: {},
      setEnabled: (enabled) => set({ enabled }),
      toggleOpen: (paneId) =>
        set((state) => ({
          openByPane: withOpen(state.openByPane, paneId, !state.openByPane[paneId]),
        })),
      setOpen: (paneId, open) =>
        set((state) =>
          Boolean(state.openByPane[paneId]) === open
            ? state
            : { openByPane: withOpen(state.openByPane, paneId, open) },
        ),
      select: (paneId, agentId) =>
        set((state) =>
          state.selectedByPane[paneId] === agentId
            ? state
            : { selectedByPane: { ...state.selectedByPane, [paneId]: agentId } },
        ),
    }),
    {
      name: "t3code:agent-stage:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ enabled: state.enabled }),
      merge: (persisted, current) => ({
        ...current,
        enabled: (persisted as { enabled?: unknown } | undefined)?.enabled === true,
      }),
    },
  ),
);

function withOpen(
  openByPane: Record<string, true>,
  paneId: string,
  open: boolean,
): Record<string, true> {
  const next = { ...openByPane };
  if (open) next[paneId] = true;
  else delete next[paneId];
  return next;
}

/** Command palette entry: the pane that owns window-level input gets the stage. */
export function toggleAgentStageForActivePane(): void {
  const { layout, activeLeafId } = useSplitThreadStore.getState();
  useAgentStageStore.getState().toggleOpen(layout.kind === "leaf" ? ROUTE_LEAF_ID : activeLeafId);
}

export function useAgentStageEnabled(): boolean {
  return useAgentStageStore((state) => state.enabled);
}

export function useAgentStageOpen(paneId: string): boolean {
  return useAgentStageStore((state) => state.enabled && state.openByPane[paneId] === true);
}
