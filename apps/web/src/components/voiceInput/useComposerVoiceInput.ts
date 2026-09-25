import type { EnvironmentId } from "@t3tools/contracts";
import { VOICE_INPUT_MAX_SECONDS } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  describeVoiceInputPreparation,
  encodeBase64,
  encodePcm16Base64,
  peakLevel,
  VOICE_INPUT_SILENCE_PEAK,
} from "./voiceInput.logic";
import { voiceInputEnvironment } from "./voiceInputState";
import { useVoiceInputStore } from "./voiceInputStore";
import {
  decodeVoiceRecording,
  isM4aRecording,
  startVoiceRecording,
  type VoiceRecording,
} from "./webVoiceRecorder";

export type ComposerVoiceInputPhase = "idle" | "starting" | "recording" | "transcribing";

/**
 * One dictation at a time for one composer: record, send the audio to the
 * environment, insert the transcript at the cursor. The composer stays
 * editable throughout; the text lands wherever the cursor is when it arrives.
 */
export function useComposerVoiceInput(input: {
  readonly environmentId: EnvironmentId;
  /** Cancels a running dictation when it changes, so a transcript never lands in another draft. */
  readonly draftKey: string;
  readonly insertText: (text: string) => boolean;
}) {
  const { environmentId } = input;
  const [phase, setPhase] = useState<ComposerVoiceInputPhase>("idle");
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
  const sessionRef = useRef(0);
  const insertTextRef = useRef(input.insertText);
  useEffect(() => {
    insertTextRef.current = input.insertText;
  });
  const transcribe = useAtomCommand(voiceInputEnvironment.transcribe, { reportFailure: false });
  const preparation = useEnvironmentQuery(
    phase === "idle" ? null : voiceInputEnvironment.prepare({ environmentId, input: {} }),
  );
  // Whether the environment has dictation at all (older and upstream servers
  // fail the call) and whether it decodes compressed recordings.
  const status = useEnvironmentQuery(
    voiceInputEnvironment.prepare({ environmentId, input: { download: false } }),
  );
  const acceptsM4a = status.data?.m4a === true;

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setRecording(null);
    setPhase("idle");
  }, []);

  const start = useCallback(async () => {
    if (recordingRef.current) return;
    const session = ++sessionRef.current;
    setPhase("starting");
    try {
      const started = await startVoiceRecording();
      if (session !== sessionRef.current) {
        started.cancel();
        return;
      }
      recordingRef.current = started;
      setRecording(started);
      setPhase("recording");
    } catch (error) {
      if (session !== sessionRef.current) return;
      setPhase("idle");
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: describeMicrophoneError(error),
      });
    }
  }, []);

  const stop = useCallback(async () => {
    const current = recordingRef.current;
    if (!current) return;
    recordingRef.current = null;
    setRecording(null);
    const session = sessionRef.current;
    setPhase("transcribing");
    const finish = (failure?: { title: string; description?: string }) => {
      if (session !== sessionRef.current) return false;
      setPhase("idle");
      if (failure) toastManager.add({ type: "error", ...failure });
      return true;
    };

    let recorded: Blob;
    let samples: Float32Array;
    try {
      recorded = await current.stop();
      samples = await decodeVoiceRecording(recorded);
    } catch {
      finish({ title: "Couldn't read the recording" });
      return;
    }
    if (session !== sessionRef.current) return;
    if (peakLevel(samples) < VOICE_INPUT_SILENCE_PEAK) {
      finish({ title: "No speech detected", description: "Check the microphone and try again." });
      return;
    }

    // Compressed audio is about a tenth of the PCM; the server trims both to the time limit.
    const audio =
      acceptsM4a && isM4aRecording(recorded)
        ? {
            audioBase64: encodeBase64(new Uint8Array(await recorded.arrayBuffer())),
            format: "m4a" as const,
          }
        : { audioBase64: encodePcm16Base64(samples) };
    const language = useVoiceInputStore.getState().language;
    const result = await transcribe({
      environmentId,
      input: language === "auto" ? audio : { ...audio, language },
    });
    if (result._tag !== "Success") {
      finish({
        title: "Couldn't transcribe the recording",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    const text = result.value.text.trim();
    if (text.length === 0) {
      finish({ title: "No speech detected" });
      return;
    }
    if (!finish()) return;
    if (!insertTextRef.current(`${text} `)) {
      // Never lose what was said: the composer can refuse text, e.g. during an approval.
      const copied = await copyToClipboard(text);
      toastManager.add({
        type: "info",
        title: copied ? "Dictation copied to the clipboard" : "The composer did not accept text",
        description: copied ? "The composer did not accept text right now." : text,
        ...(copied ? {} : { timeout: 0 }),
      });
    }
  }, [acceptsM4a, environmentId, transcribe]);

  const toggle = useCallback(() => {
    if (phase === "recording") void stop();
    else if (phase === "idle") void start();
  }, [phase, start, stop]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setTimeout(() => void stop(), VOICE_INPUT_MAX_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [phase, stop]);

  const previousKeyRef = useRef({ environmentId, draftKey: input.draftKey });
  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous.environmentId === environmentId && previous.draftKey === input.draftKey) return;
    previousKeyRef.current = { environmentId, draftKey: input.draftKey };
    cancel();
  }, [cancel, environmentId, input.draftKey]);

  useEffect(() => cancel, [cancel]);

  return {
    /** False when the environment cannot transcribe, e.g. a server without the fork. */
    supported: status.error === null,
    phase,
    recording,
    /** Download or load progress of the model while it is not ready yet. */
    preparationLabel: describeVoiceInputPreparation(preparation.data),
    start,
    stop,
    cancel,
    toggle,
  };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function describeMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Microphone access was denied. Allow it in the browser or system settings.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
  }
  return error instanceof Error ? error.message : "The microphone could not be opened.";
}
