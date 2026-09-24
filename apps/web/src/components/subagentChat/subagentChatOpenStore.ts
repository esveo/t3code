import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Which subagent's chat the Agents panel shows, per thread key. Session state
 * outside the panel, so other surfaces (the agent stage) can open the panel
 * straight into one agent's chat.
 */
interface SubagentChatOpenState {
  openByThread: Record<string, string>;
  setOpen: (threadKey: string, agentId: string | null) => void;
}

export const useSubagentChatOpenStore = create<SubagentChatOpenState>()((set) => ({
  openByThread: {},
  setOpen: (threadKey, agentId) =>
    set((state) => {
      if ((state.openByThread[threadKey] ?? null) === agentId) return state;
      const { [threadKey]: _, ...rest } = state.openByThread;
      return { openByThread: agentId === null ? rest : { ...rest, [threadKey]: agentId } };
    }),
}));

/** The store's key for a thread; "" when there is no thread to key by. */
export function subagentChatKey(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): string {
  return environmentId === null || threadId === null
    ? ""
    : scopedThreadKey(scopeThreadRef(environmentId, threadId));
}
