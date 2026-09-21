import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * Agent stage: a right-panel surface that draws the running agents as sprites
 * moving between the kinds of work they do. The setting and the thought
 * bubble toggle persist; which agent each thread's stage follows is session
 * state.
 */
interface AgentStageStoreState {
  /** The setting: whether the stage can be opened at all. */
  enabled: boolean;
  /** A bubble above the selected sprite with its latest thought. */
  showThoughts: boolean;
  selectedByThread: Record<string, string>;
  setEnabled: (enabled: boolean) => void;
  setShowThoughts: (showThoughts: boolean) => void;
  select: (threadKey: string, agentId: string) => void;
}

export const useAgentStageStore = create<AgentStageStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      showThoughts: true,
      selectedByThread: {},
      setEnabled: (enabled) => set({ enabled }),
      setShowThoughts: (showThoughts) => set({ showThoughts }),
      select: (threadKey, agentId) =>
        set((state) =>
          state.selectedByThread[threadKey] === agentId
            ? state
            : { selectedByThread: { ...state.selectedByThread, [threadKey]: agentId } },
        ),
    }),
    {
      name: "t3code:agent-stage:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ enabled: state.enabled, showThoughts: state.showThoughts }),
      merge: (persisted, current) => {
        const stored = persisted as { enabled?: unknown; showThoughts?: unknown } | undefined;
        return {
          ...current,
          enabled: stored?.enabled === true,
          showThoughts: stored?.showThoughts !== false,
        };
      },
    },
  ),
);

export function useAgentStageEnabled(): boolean {
  return useAgentStageStore((state) => state.enabled);
}
