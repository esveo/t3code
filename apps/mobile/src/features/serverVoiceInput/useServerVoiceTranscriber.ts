import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import * as Cause from "effect/Cause";
import { File } from "expo-file-system";
import { useContext, useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { localeLanguage } from "./localeLanguage";
import { serverVoiceInputEnvironment } from "./voiceInputState";

/**
 * Fork: dictation through the environment's Whisper, for phones without
 * on-device transcription (Android, older iOS). Null until the environment
 * reports its model on disk, i.e. until someone turned voice input on in the
 * web or desktop settings, and while it cannot decode phone recordings (a
 * Linux server without ffmpeg). The check stays open until the model arrives.
 */
export function useServerVoiceTranscriber(
  environmentId: EnvironmentId | null,
): VoiceTranscriber | null {
  const registry = useContext(RegistryContext);
  const status = useEnvironmentQuery(
    environmentId
      ? serverVoiceInputEnvironment.prepare({ environmentId, input: { download: false } })
      : null,
  );
  const ready = status.data?.phase === "ready" && status.data.m4a !== false;

  return useMemo(() => {
    if (!environmentId || !ready) return null;
    return {
      prepare: async ({ signal }) => {
        throwIfVoiceTranscriptionAborted(signal);
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        // Steers Whisper towards the device language; left to guess, it takes
        // short German sentences with English jargon for English.
        const language = localeLanguage(locale);
        return {
          locale,
          transcribe: async (uri, options) => {
            throwIfVoiceTranscriptionAborted(options.signal);
            const audioBase64 = await new File(uri).base64();
            throwIfVoiceTranscriptionAborted(options.signal);
            const result = await runAtomCommand(
              registry,
              serverVoiceInputEnvironment.transcribe,
              {
                environmentId,
                input: { audioBase64, format: "m4a", ...(language ? { language } : {}) },
              },
              {
                label: serverVoiceInputEnvironment.transcribe.label,
                reportFailure: false,
                reportDefect: false,
              },
            );
            throwIfVoiceTranscriptionAborted(options.signal);
            if (result._tag !== "Success") {
              throw new VoiceTranscriptionError(
                "transcription-failed",
                "The server could not transcribe this recording.",
                { cause: Cause.squash(result.cause) },
              );
            }
            return result.value.text;
          },
        };
      },
    };
  }, [environmentId, ready, registry]);
}
