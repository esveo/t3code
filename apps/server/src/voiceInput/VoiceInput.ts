// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- the model download streams to disk while hashing; plain Node streams keep that simple.
/**
 * Fork: server side of dictation in the composer. Transcribes locally with
 * whisper.cpp through @fugood/whisper.node (Metal on Apple silicon), so no
 * audio leaves the environment. The model lives in T3 home and is shared by
 * dev and production state.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  VOICE_INPUT_MAX_SECONDS,
  VoiceInputError,
  type VoiceInputPrepareInput,
  type VoiceInputPrepareProgress,
  type VoiceInputTranscribeInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import {
  canConvertM4a,
  convertM4aToPcm16,
  isSilentPcm16,
  limitPcm16Duration,
} from "./audioConversion.ts";
import { WhisperTranscriber } from "./whisperTranscriber.ts";
import { loadWhisperContextInWorker } from "./whisperWorker.ts";

// Whisper large-v3-turbo, quantized: close to large-v3 quality at a fraction of
// the cost, and good with German and English mixed in one sentence.
const MODEL = {
  fileName: "ggml-large-v3-turbo-q5_0.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
} as const;
const IDLE_RELEASE_MS = 10 * 60 * 1000;
/** A download that receives nothing for this long is abandoned, so the next attempt can start over. */
const DOWNLOAD_STALL_MS = 60 * 1000;

async function modelExists(modelPath: string): Promise<boolean> {
  return NodeFSP.stat(modelPath).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

async function downloadModel(
  modelPath: string,
  onProgress: (receivedBytes: number, totalBytes: number) => void,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(modelPath), { recursive: true });
  const partialPath = `${modelPath}.${process.pid}.part`;
  const stalled = new AbortController();
  const abortStalled = () => stalled.abort(new Error("The model download stalled."));
  let stallTimer = setTimeout(abortStalled, DOWNLOAD_STALL_MS);
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(abortStalled, DOWNLOAD_STALL_MS);
  };
  try {
    const response = await fetch(MODEL.url, { signal: stalled.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed with HTTP ${response.status}.`);
    }
    const totalBytes = Number(response.headers.get("content-length") ?? 0);
    const hash = NodeCrypto.createHash("sha256");
    let receivedBytes = 0;
    const meter = new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        receivedBytes += chunk.length;
        resetStallTimer();
        onProgress(receivedBytes, totalBytes);
        callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      meter,
      NodeFS.createWriteStream(partialPath),
      { signal: stalled.signal },
    );
    if (hash.digest("hex") !== MODEL.sha256) {
      throw new Error("The downloaded speech model is corrupt.");
    }
    await NodeFSP.rename(partialPath, modelPath);
  } finally {
    clearTimeout(stallTimer);
    await NodeFSP.rm(partialPath, { force: true });
  }
}

let transcriber: WhisperTranscriber | null = null;

const getTranscriber = Effect.gen(function* () {
  const config = yield* ServerConfig;
  transcriber ??= new WhisperTranscriber({
    modelPath: NodePath.join(config.baseDir, "models", "whisper", MODEL.fileName),
    modelExists,
    downloadModel,
    loadContext: loadWhisperContextInWorker,
    idleReleaseMs: IDLE_RELEASE_MS,
  });
  return transcriber;
});

function toVoiceInputError(cause: unknown): VoiceInputError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new VoiceInputError({ message: `Voice input failed: ${detail}` });
}

/**
 * Streams the model's download progress and ends once it is on disk. A check
 * (`download: false`) that finds it missing stays open until it arrives.
 */
export const prepareRpc = (input: VoiceInputPrepareInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const whisper = yield* getTranscriber;
      const platform = yield* HostProcessPlatform;
      const m4a = yield* Effect.promise(() => canConvertM4a(platform));
      return Stream.callback<VoiceInputPrepareProgress, VoiceInputError>((queue) =>
        Effect.tryPromise({
          try: (signal) =>
            whisper.prepare(
              (progress) => Queue.offerUnsafe(queue, { ...progress, m4a }),
              signal,
              input,
            ),
          catch: toVoiceInputError,
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) => Queue.fail(queue, error),
            onSuccess: () => Queue.end(queue),
          }),
          Effect.forkScoped,
        ),
      );
    }),
  );

export const transcribeRpc = Effect.fn("voiceInput.transcribe")(function* (
  input: VoiceInputTranscribeInput,
) {
  const audio = Buffer.from(input.audioBase64, "base64");
  const isM4a = input.format === "m4a";
  if (audio.length === 0 || (!isM4a && audio.length % 2 !== 0)) {
    return yield* new VoiceInputError({ message: "The recording is empty or not 16-bit PCM." });
  }
  const whisper = yield* getTranscriber;
  const platform = yield* HostProcessPlatform;
  const recorded = isM4a
    ? yield* Effect.tryPromise({
        try: () => convertM4aToPcm16(audio, platform),
        catch: toVoiceInputError,
      })
    : audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
  // A recording stopped at the limit runs a little over it.
  const pcm = limitPcm16Duration(recorded, VOICE_INPUT_MAX_SECONDS);
  // Whisper turns silence into phrases like "Thank you.", so silence never reaches it.
  if (isSilentPcm16(pcm)) return { text: "" };
  const text = yield* Effect.tryPromise({
    try: (signal) => whisper.transcribe(pcm, signal, input.language ?? "auto"),
    catch: toVoiceInputError,
  });
  return { text };
});
