// @effect-diagnostics nodeBuiltinImport:off
/* oxlint-disable unicorn/require-post-message-target-origin -- worker_threads ports take no origin. */
/**
 * Fork: runs whisper.cpp in a worker thread. Loading the model is synchronous
 * inside the addon and takes about 20 seconds the first time Metal compiles
 * its shaders; on the server's own thread that stalls every WebSocket and
 * running agent. The worker is created from source text so the single
 * executable needs no extra file, and it loads the addon by absolute path.
 */
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";

import type { WhisperContextLike } from "./whisperTranscriber.ts";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const whisper = require(workerData.modulePath);
const jobs = new Map();
let context = null;
parentPort.on("message", async (message) => {
  try {
    if (message.type === "init") {
      context = await whisper.initWhisper({ filePath: message.modelPath, useGpu: true });
      parentPort.postMessage({ type: "ready" });
    } else if (message.type === "transcribe") {
      const job = context.transcribeData(message.audio, { language: message.language });
      jobs.set(message.id, job);
      const result = await job.promise;
      jobs.delete(message.id);
      parentPort.postMessage({ type: "result", id: message.id, result: result.result, isAborted: result.isAborted });
    } else if (message.type === "stop") {
      await jobs.get(message.id)?.stop();
    } else if (message.type === "release") {
      await context?.release();
      parentPort.close();
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", id: message.id ?? null, message: String(error?.message ?? error) });
  }
});
`;

type WorkerReply =
  | { readonly type: "ready" }
  | {
      readonly type: "result";
      readonly id: number;
      readonly result: string;
      readonly isAborted: boolean;
    }
  | { readonly type: "error"; readonly id: number | null; readonly message: string };

// Native addon, external to the CLI bundle; see NodePtyAdapter for why it is
// resolved with `require` rather than `import()`.
const requireForWhisper = NodeModule.createRequire(import.meta.url);

/** Loads the model in a fresh worker; `release` ends the worker. */
export function loadWhisperContextInWorker(modelPath: string): Promise<WhisperContextLike> {
  const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { modulePath: requireForWhisper.resolve("@fugood/whisper.node") },
  });
  const pending = new Map<
    number,
    {
      resolve: (result: { result: string; isAborted: boolean }) => void;
      reject: (error: Error) => void;
    }
  >();
  let nextId = 0;
  let failure: Error | null = null;
  const failAll = (error: Error) => {
    failure = error;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };

  return new Promise<WhisperContextLike>((resolveReady, rejectReady) => {
    worker.on("message", (reply: WorkerReply) => {
      if (reply.type === "ready") {
        resolveReady(context);
      } else if (reply.type === "result") {
        pending.get(reply.id)?.resolve({ result: reply.result, isAborted: reply.isAborted });
        pending.delete(reply.id);
      } else if (reply.id === null) {
        rejectReady(new Error(reply.message));
        void worker.terminate();
      } else {
        pending.get(reply.id)?.reject(new Error(reply.message));
        pending.delete(reply.id);
      }
    });
    worker.on("error", (error) => {
      rejectReady(error);
      failAll(error);
    });
    worker.on("exit", () => failAll(new Error("The speech worker stopped.")));

    const context: WhisperContextLike = {
      transcribeData: (audio, options) => {
        const id = nextId++;
        const promise = new Promise<{ result: string; isAborted: boolean }>((resolve, reject) => {
          if (failure) return reject(failure);
          pending.set(id, { resolve, reject });
        });
        worker.postMessage({ type: "transcribe", id, audio, language: options.language }, [audio]);
        return {
          promise,
          stop: async () => worker.postMessage({ type: "stop", id }),
        };
      },
      release: async () => {
        worker.postMessage({ type: "release" });
      },
    };
    worker.postMessage({ type: "init", modelPath });
  });
}
