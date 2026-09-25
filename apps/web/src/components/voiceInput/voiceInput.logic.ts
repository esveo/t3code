import type { VoiceInputPrepareProgress } from "@t3tools/contracts";

/** Below this peak the recording is treated as silence; Whisper invents text for silence. */
export const VOICE_INPUT_SILENCE_PEAK = 0.02;

/** 16-bit little-endian PCM as base64, the format `voiceInput.transcribe` takes. */
export function encodePcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

export function formatVoiceElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** What the composer shows while the model is not ready yet, or null once it is. */
export function describeVoiceInputPreparation(
  progress: VoiceInputPrepareProgress | null,
): string | null {
  if (!progress || progress.phase === "ready") return null;
  if (progress.totalBytes <= 0) return "Downloading speech model…";
  const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
  return `Downloading speech model ${percent}%`;
}

/** Download progress for the toast, whose title already names the download. */
export function describeVoiceInputDownload(progress: VoiceInputPrepareProgress): string {
  if (progress.totalBytes <= 0) return "Starting…";
  const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);
  const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
  return `${percent}% · ${megabytes(progress.receivedBytes)} of ${megabytes(progress.totalBytes)} MB`;
}
