import type { EnvironmentId } from "@t3tools/contracts";
import { VOICE_INPUT_MAX_SECONDS } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  describeVoiceInputPreparation,
  encodePcm16Base64,
  peakLevel,
  VOICE_INPUT_SILENCE_PEAK,
} from "./voiceInput.logic";
import { voiceInputEnvironment } from "./voiceInputState";
import { startVoiceRecording, type VoiceRecording } from "./webVoiceRecorder";

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

    let samples: Float32Array;
    try {
      samples = await current.stop();
    } catch {
      finish({ title: "Couldn't read the recording" });
      return;
    }
    if (session !== sessionRef.current) return;
    if (peakLevel(samples) < VOICE_INPUT_SILENCE_PEAK) {
      finish({ title: "No speech detected", description: "Check the microphone and try again." });
      return;
    }

    const result = await transcribe({
      environmentId,
      input: { audioBase64: encodePcm16Base64(samples) },
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
      void navigator.clipboard?.writeText(text).catch(() => {});
      toastManager.add({
        type: "info",
        title: "Dictation copied to the clipboard",
        description: "The composer did not accept text right now.",
      });
    }
  }, [environmentId, transcribe]);

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

function describeMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Microphone access was denied. Allow it in the browser or system settings.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
  }
  return error instanceof Error ? error.message : "The microphone could not be opened.";
}
