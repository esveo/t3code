// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- the model download streams to disk while hashing; plain Node streams keep that simple.
/**
 * Fork: server side of dictation in the composer. Transcribes locally with
 * whisper.cpp through @fugood/whisper.node (Metal on Apple silicon), so no
 * audio leaves the environment. The model lives in T3 home and is shared by
 * dev and production state.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  VoiceInputError,
  type VoiceInputPrepareProgress,
  type VoiceInputTranscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { WhisperTranscriber, type WhisperContextLike } from "./whisperTranscriber.ts";

// Whisper large-v3-turbo, quantized: close to large-v3 quality at a fraction of
// the cost, and good with German and English mixed in one sentence.
const MODEL = {
  fileName: "ggml-large-v3-turbo-q5_0.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
} as const;
const IDLE_RELEASE_MS = 10 * 60 * 1000;

// Native addon, external to the CLI bundle; see NodePtyAdapter for why it is
// loaded with `require` rather than `import()`.
const requireForWhisper = NodeModule.createRequire(import.meta.url);

type WhisperModule = {
  readonly initWhisper: (options: {
    readonly filePath: string;
    readonly useGpu: boolean;
  }) => Promise<WhisperContextLike>;
};

async function loadContext(modelPath: string): Promise<WhisperContextLike> {
  const whisper = requireForWhisper("@fugood/whisper.node") as WhisperModule;
  return whisper.initWhisper({ filePath: modelPath, useGpu: true });
}

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
  try {
    const response = await fetch(MODEL.url);
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
        onProgress(receivedBytes, totalBytes);
        callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      meter,
      NodeFS.createWriteStream(partialPath),
    );
    if (hash.digest("hex") !== MODEL.sha256) {
      throw new Error("The downloaded speech model is corrupt.");
    }
    await NodeFSP.rename(partialPath, modelPath);
  } finally {
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
    loadContext,
    idleReleaseMs: IDLE_RELEASE_MS,
  });
  return transcriber;
});

function toVoiceInputError(cause: unknown): VoiceInputError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new VoiceInputError({ message: `Voice input failed: ${detail}` });
}

/** Streams the model's download and load progress, ending once it is ready. */
export const prepareRpc = () =>
  Stream.unwrap(
    Effect.map(getTranscriber, (whisper) =>
      Stream.callback<VoiceInputPrepareProgress, VoiceInputError>((queue) =>
        Effect.tryPromise({
          try: (signal) =>
            whisper.prepare((progress) => Queue.offerUnsafe(queue, progress), signal),
          catch: toVoiceInputError,
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) => Queue.fail(queue, error),
            onSuccess: () => Queue.end(queue),
          }),
          Effect.forkScoped,
        ),
      ),
    ),
  );

export const transcribeRpc = Effect.fn("voiceInput.transcribe")(function* (
  input: VoiceInputTranscribeInput,
) {
  const audio = Buffer.from(input.audioBase64, "base64");
  if (audio.length === 0 || audio.length % 2 !== 0) {
    return yield* new VoiceInputError({ message: "The recording is not 16-bit PCM audio." });
  }
  const whisper = yield* getTranscriber;
  const pcm = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
  const text = yield* Effect.tryPromise({
    try: (signal) => whisper.transcribe(pcm, signal),
    catch: toVoiceInputError,
  });
  return { text };
});
