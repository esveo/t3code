import type { ForkInstructionsProvider, ForkInstructionsScope } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/**
 * Fork: the Instructions tab's view state. Scope and provider are remembered
 * per thread (its scoped thread key); without a provider the server picks the
 * thread's own.
 */
interface ForkInstructionsStoreState {
  scopeByThreadKey: Readonly<Record<string, ForkInstructionsScope>>;
  providerByThreadKey: Readonly<Record<string, ForkInstructionsProvider>>;
  setScope: (threadKey: string, scope: ForkInstructionsScope) => void;
  setProvider: (threadKey: string, provider: ForkInstructionsProvider) => void;
}

export const useForkInstructionsStore = create<ForkInstructionsStoreState>()(
  persist(
    (set) => ({
      scopeByThreadKey: {},
      providerByThreadKey: {},
      setScope: (threadKey, scope) =>
        set((state) => ({ scopeByThreadKey: { ...state.scopeByThreadKey, [threadKey]: scope } })),
      setProvider: (threadKey, provider) =>
        set((state) => ({
          providerByThreadKey: { ...state.providerByThreadKey, [threadKey]: provider },
        })),
    }),
    {
      name: "t3code:fork-instructions:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

/** Unsaved edits per environment and file, kept while switching away; not persisted. */
export interface ForkInstructionsDraft {
  readonly content: string;
  /** The file's version the edit started from. */
  readonly base: string | null;
}

export const useForkInstructionsDrafts = create<{
  drafts: Readonly<Record<string, ForkInstructionsDraft>>;
  setDraft: (key: string, draft: ForkInstructionsDraft | null) => void;
}>()((set) => ({
  drafts: {},
  setDraft: (key, draft) =>
    set((state) => {
      const { [key]: _previous, ...rest } = state.drafts;
      return { drafts: draft === null ? rest : { ...rest, [key]: draft } };
    }),
}));
