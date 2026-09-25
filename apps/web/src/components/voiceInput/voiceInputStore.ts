import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/** The dictation setting. Off by default, since turning it on downloads a 550 MB model. */
interface VoiceInputStoreState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useVoiceInputStore = create<VoiceInputStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "t3code:voice-input:v1",
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
