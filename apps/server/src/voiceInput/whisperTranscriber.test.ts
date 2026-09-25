import type { VoiceInputPrepareProgress } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { WhisperTranscriber, type WhisperContextLike } from "./whisperTranscriber.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeContext(transcript = " Hallo Welt ") {
  const stop = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const context: WhisperContextLike = {
    transcribeData: () => ({
      stop,
      promise: Promise.resolve({ result: transcript, isAborted: false }),
    }),
    release,
  };
  return { context, stop, release };
}

function setup(options: { exists?: boolean; context?: WhisperContextLike } = {}) {
  let exists = options.exists ?? false;
  const download = deferred<void>();
  const downloadModel = vi.fn(
    async (_path: string, onProgress: (received: number, total: number) => void) => {
      onProgress(0, 1000);
      onProgress(4, 1000);
      onProgress(500, 1000);
      await download.promise;
      exists = true;
    },
  );
  const context = options.context ?? fakeContext().context;
  const loadContext = vi.fn(async () => context);
  const transcriber = new WhisperTranscriber({
    modelPath: "/models/whisper.bin",
    modelExists: async () => exists,
    downloadModel,
    loadContext,
    idleReleaseMs: 1000,
  });
  return { transcriber, download, downloadModel, loadContext };
}

const pcm = new ArrayBuffer(3200);

describe("WhisperTranscriber", () => {
  it("downloads once for concurrent callers and reports progress per percent", async () => {
    const { transcriber, download, downloadModel } = setup();
    const first: VoiceInputPrepareProgress[] = [];
    const second: VoiceInputPrepareProgress[] = [];
    const preparing = transcriber.prepare((progress) => first.push(progress));
    const transcribing = transcriber.transcribe(pcm);
    await vi.waitFor(() => expect(first).toHaveLength(2));
    const joining = transcriber.prepare((progress) => second.push(progress));
    download.resolve();

    await expect(transcribing).resolves.toBe("Hallo Welt");
    await Promise.all([preparing, joining]);
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect(first.map((progress) => [progress.phase, progress.receivedBytes])).toEqual([
      ["downloading", 0],
      ["downloading", 500],
      ["ready", 0],
    ]);
    // A caller joining mid-download starts from the latest progress.
    expect(second[0]).toEqual({ phase: "downloading", receivedBytes: 500, totalBytes: 1000 });
    expect(second.at(-1)?.phase).toBe("ready");
  });

  it("retries the download after it failed", async () => {
    const { transcriber, download, downloadModel } = setup();
    const failing = transcriber.transcribe(pcm);
    download.reject(new Error("offline"));
    await expect(failing).rejects.toThrow("offline");

    const retry = transcriber.transcribe(pcm);
    await expect(retry).rejects.toThrow("offline");
    expect(downloadModel).toHaveBeenCalledTimes(2);
  });

  it("prepares by downloading only, and loads the model on the first transcription", async () => {
    const { transcriber, download, loadContext } = setup();
    const preparing = transcriber.prepare(() => {});
    download.resolve();
    await preparing;
    expect(loadContext).not.toHaveBeenCalled();

    await expect(transcriber.transcribe(pcm)).resolves.toBe("Hallo Welt");
    expect(loadContext).toHaveBeenCalledTimes(1);
  });

  it("only checks for the model when asked not to download", async () => {
    const { transcriber, download, downloadModel } = setup();
    const checks: string[] = [];
    await transcriber.prepare((progress) => checks.push(progress.phase), undefined, {
      download: false,
    });
    expect(checks).toEqual(["missing"]);
    expect(downloadModel).not.toHaveBeenCalled();

    const downloading = transcriber.prepare(() => {});
    // A check during a running download follows it instead of answering "missing".
    const joining = transcriber.prepare((progress) => checks.push(progress.phase), undefined, {
      download: false,
    });
    download.resolve();
    await Promise.all([downloading, joining]);
    expect(checks.at(-1)).toBe("ready");
  });

  it("keeps downloading for others when one caller cancels", async () => {
    const { transcriber, download, loadContext } = setup();
    const controller = new AbortController();
    const cancelled = transcriber.prepare(() => {}, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toBeDefined();

    download.resolve();
    await expect(transcriber.transcribe(pcm)).resolves.toBe("Hallo Welt");
    expect(loadContext).toHaveBeenCalledTimes(1);
  });

  it("releases the model after it sat idle and loads it again on the next dictation", async () => {
    vi.useFakeTimers();
    try {
      const { context, release } = fakeContext();
      const { transcriber, loadContext } = setup({ exists: true, context });
      await transcriber.transcribe(pcm);
      await vi.advanceTimersByTimeAsync(999);
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(release).toHaveBeenCalledTimes(1);

      await transcriber.transcribe(pcm);
      expect(loadContext).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the native transcription when the caller cancels", async () => {
    const started = deferred<void>();
    const pending = deferred<{ result: string; isAborted: boolean }>();
    const stop = vi.fn(async () => pending.resolve({ result: "", isAborted: true }));
    const context: WhisperContextLike = {
      transcribeData: () => {
        started.resolve();
        return { stop, promise: pending.promise };
      },
      release: async () => {},
    };
    const { transcriber } = setup({ exists: true, context });
    const controller = new AbortController();
    const running = transcriber.transcribe(pcm, controller.signal);
    await started.promise;
    controller.abort();

    await expect(running).rejects.toBeDefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
