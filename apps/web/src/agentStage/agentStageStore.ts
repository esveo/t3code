import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/** Whether the stage shows the open thread alone or every thread with live work. */
export type AgentStageMode = "thread" | "everything";

/** The key the everything view files its hidden threads under. */
export const AGENT_STAGE_EVERYTHING_KEY = "everything";

/**
 * Agent stage: a right-panel surface that draws the running agents as sprites
 * moving between the kinds of work they do. The setting persists; which
 * agent each thread's stage follows, which agents the user has hidden from
 * it, and the mode are session state.
 */
interface AgentStageStoreState {
  /** The setting: whether the stage can be opened at all. */
  enabled: boolean;
  mode: AgentStageMode;
  selectedByThread: Record<string, string>;
  /** Agents hidden from the stage, per thread key. Display only: they keep working. */
  hiddenByThread: Record<string, ReadonlyArray<string>>;
  setEnabled: (enabled: boolean) => void;
  setMode: (mode: AgentStageMode) => void;
  select: (threadKey: string, agentId: string) => void;
  hide: (threadKey: string, agentId: string) => void;
  show: (threadKey: string, agentId: string) => void;
  showAll: (threadKey: string) => void;
}

export const useAgentStageStore = create<AgentStageStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      mode: "thread",
      selectedByThread: {},
      hiddenByThread: {},
      setEnabled: (enabled) => set({ enabled }),
      setMode: (mode) => set({ mode }),
      select: (threadKey, agentId) =>
        set((state) =>
          state.selectedByThread[threadKey] === agentId
            ? state
            : { selectedByThread: { ...state.selectedByThread, [threadKey]: agentId } },
        ),
      hide: (threadKey, agentId) =>
        set((state) => {
          const hidden = state.hiddenByThread[threadKey] ?? [];
          if (hidden.includes(agentId)) return state;
          return { hiddenByThread: { ...state.hiddenByThread, [threadKey]: [...hidden, agentId] } };
        }),
      show: (threadKey, agentId) =>
        set((state) => {
          const hidden = state.hiddenByThread[threadKey] ?? [];
          if (!hidden.includes(agentId)) return state;
          return {
            hiddenByThread: {
              ...state.hiddenByThread,
              [threadKey]: hidden.filter((id) => id !== agentId),
            },
          };
        }),
      showAll: (threadKey) =>
        set((state) => {
          if ((state.hiddenByThread[threadKey] ?? []).length === 0) return state;
          const { [threadKey]: _, ...rest } = state.hiddenByThread;
          return { hiddenByThread: rest };
        }),
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
