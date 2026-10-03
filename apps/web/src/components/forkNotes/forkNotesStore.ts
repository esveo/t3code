import type { ForkNoteScope } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/**
 * Fork: the Notes tab's view state. The scope shown is remembered per thread
 * (its scoped thread key), the Done group's fold per list.
 */
interface ForkNotesStoreState {
  scopeByThreadKey: Readonly<Record<string, ForkNoteScope>>;
  doneOpenByList: Readonly<Record<string, boolean>>;
  /** Whether the add field makes todos instead of notes. */
  addAsTodo: boolean;
  setScope: (threadKey: string, scope: ForkNoteScope) => void;
  setDoneOpen: (listKey: string, open: boolean) => void;
  setAddAsTodo: (todo: boolean) => void;
}

export const useForkNotesStore = create<ForkNotesStoreState>()(
  persist(
    (set) => ({
      scopeByThreadKey: {},
      doneOpenByList: {},
      addAsTodo: false,
      setScope: (threadKey, scope) =>
        set((state) => ({ scopeByThreadKey: { ...state.scopeByThreadKey, [threadKey]: scope } })),
      setDoneOpen: (listKey, open) =>
        set((state) => ({ doneOpenByList: { ...state.doneOpenByList, [listKey]: open } })),
      setAddAsTodo: (addAsTodo) => set({ addAsTodo }),
    }),
    {
      name: "t3code:fork-notes:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

/** The capture dialog; not persisted. `prefill` is what it opens with. */
export const useForkNotesCaptureStore = create<{
  open: boolean;
  prefill: string;
  show: (prefill: string) => void;
  close: () => void;
}>()((set) => ({
  open: false,
  prefill: "",
  show: (prefill) => set({ open: true, prefill }),
  close: () => set({ open: false }),
}));
