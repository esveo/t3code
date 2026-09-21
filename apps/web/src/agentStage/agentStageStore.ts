import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * Agent stage: a right-panel surface that draws the running agents as sprites
 * moving between the kinds of work they do. The setting persists; which
 * agent each thread's stage follows is session state.
 */
interface AgentStageStoreState {
  /** The setting: whether the stage can be opened at all. */
  enabled: boolean;
  selectedByThread: Record<string, string>;
  setEnabled: (enabled: boolean) => void;
  select: (threadKey: string, agentId: string) => void;
}

export const useAgentStageStore = create<AgentStageStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      selectedByThread: {},
      setEnabled: (enabled) => set({ enabled }),
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
      partialize: (state) => ({ enabled: state.enabled }),
      merge: (persisted, current) => ({
        ...current,
        enabled: (persisted as { enabled?: unknown } | undefined)?.enabled === true,
      }),
    },
  ),
);

export function useAgentStageEnabled(): boolean {
  return useAgentStageStore((state) => state.enabled);
}
