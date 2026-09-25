import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export const VOICE_INPUT_LANGUAGES = ["auto", "de", "en"] as const;
export type VoiceInputLanguageChoice = (typeof VOICE_INPUT_LANGUAGES)[number];

/**
 * The dictation setting. Off by default, since turning it on downloads a 550 MB
 * model. The language steers Whisper, which otherwise guesses per recording
 * and takes short German sentences with English jargon for English.
 */
interface VoiceInputStoreState {
  enabled: boolean;
  language: VoiceInputLanguageChoice;
  setEnabled: (enabled: boolean) => void;
  setLanguage: (language: VoiceInputLanguageChoice) => void;
}

export const useVoiceInputStore = create<VoiceInputStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      language: "auto",
      setEnabled: (enabled) => set({ enabled }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: "t3code:voice-input:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ enabled: state.enabled, language: state.language }),
      merge: (persisted, current) => {
        const stored = persisted as { enabled?: unknown; language?: unknown } | undefined;
        const language = VOICE_INPUT_LANGUAGES.find((choice) => choice === stored?.language);
        return { ...current, enabled: stored?.enabled === true, language: language ?? "auto" };
      },
    },
  ),
);
