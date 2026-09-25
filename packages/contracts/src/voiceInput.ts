/**
 * Fork: dictation in the composer. The client records the microphone and sends
 * the audio to its environment, which transcribes it locally with Whisper.
 * `prepare` downloads the model when the user turns dictation on; with
 * `download: false` it only reports whether the model is there, which is how
 * the mobile app decides to offer dictation.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";

export const VOICE_INPUT_WS_METHODS = {
  prepare: "voiceInput.prepare",
  transcribe: "voiceInput.transcribe",
} as const;

/** Audio travels as 16 kHz mono signed 16-bit little-endian PCM. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_INPUT_MAX_SECONDS = 5 * 60;
/** Base64 of the longest recording: 2 bytes per sample, 4 characters per 3 bytes. */
export const VOICE_INPUT_MAX_AUDIO_BASE64_LENGTH =
  Math.ceil((VOICE_INPUT_MAX_SECONDS * VOICE_INPUT_SAMPLE_RATE * 2) / 3) * 4;

export const VoiceInputPrepareInput = Schema.Struct({
  /** Defaults to true. False only checks for the model. */
  download: Schema.optionalKey(Schema.Boolean),
});
export type VoiceInputPrepareInput = typeof VoiceInputPrepareInput.Type;

export const VoiceInputPrepareProgress = Schema.Struct({
  /** `missing` only answers a check that did not download. */
  phase: Schema.Literals(["missing", "downloading", "ready"]),
  /** Download progress of the model; both are 0 once it is on disk. */
  receivedBytes: Schema.Number,
  totalBytes: Schema.Number,
});
export type VoiceInputPrepareProgress = typeof VoiceInputPrepareProgress.Type;

export const VoiceInputTranscribeInput = Schema.Struct({
  audioBase64: Schema.String.check(Schema.isMaxLength(VOICE_INPUT_MAX_AUDIO_BASE64_LENGTH)),
  /**
   * Defaults to `pcm16`. `m4a` is AAC as phones record it; the server converts
   * it with afconvert (macOS) or ffmpeg.
   */
  format: Schema.optionalKey(Schema.Literals(["pcm16", "m4a"])),
});
export type VoiceInputTranscribeInput = typeof VoiceInputTranscribeInput.Type;

export const VoiceInputTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceInputTranscribeResult = typeof VoiceInputTranscribeResult.Type;

export class VoiceInputError extends Schema.TaggedError<VoiceInputError>()("VoiceInputError", {
  message: Schema.String,
}) {}

export const WsVoiceInputPrepareRpc = Rpc.make(VOICE_INPUT_WS_METHODS.prepare, {
  payload: VoiceInputPrepareInput,
  success: VoiceInputPrepareProgress,
  error: Schema.Union([VoiceInputError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVoiceInputTranscribeRpc = Rpc.make(VOICE_INPUT_WS_METHODS.transcribe, {
  payload: VoiceInputTranscribeInput,
  success: VoiceInputTranscribeResult,
  error: Schema.Union([VoiceInputError, EnvironmentAuthorizationError]),
});
