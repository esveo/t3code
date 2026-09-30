import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/** Fork: whether sent messages may trigger easter eggs. Off until the user opts in. */
interface EasterEggStoreState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useEasterEggStore = create<EasterEggStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "t3code:easter-eggs:v1",
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
