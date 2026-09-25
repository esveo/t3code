// @effect-diagnostics globalTimers:off -- the idle release outlives any single request, so it is not tied to an Effect scope.
/**
 * Fork: owns the Whisper model for dictation. The model is downloaded once,
 * when the user turns dictation on, loaded on first use and released again
 * after a quiet spell, because a loaded model holds about a gigabyte of
 * memory. Transcriptions run one at a time on the single loaded context.
 */
import type { VoiceInputPrepareProgress } from "@t3tools/contracts";

export interface WhisperContextLike {
  transcribeData(
    audio: ArrayBuffer,
    options: { readonly language: string },
  ): {
    readonly stop: () => Promise<void>;
    readonly promise: Promise<{ readonly result: string; readonly isAborted: boolean }>;
  };
  release(): Promise<void>;
}

export interface WhisperTranscriberDependencies {
  readonly modelPath: string;
  readonly modelExists: (modelPath: string) => Promise<boolean>;
  /** Writes the model to `modelPath` atomically, reporting bytes as they arrive. */
  readonly downloadModel: (
    modelPath: string,
    onProgress: (receivedBytes: number, totalBytes: number) => void,
  ) => Promise<void>;
  readonly loadContext: (modelPath: string) => Promise<WhisperContextLike>;
  readonly idleReleaseMs: number;
}

type ProgressListener = (progress: VoiceInputPrepareProgress) => void;

export class WhisperTranscriber {
  private readonly dependencies: WhisperTranscriberDependencies;
  private modelFile: Promise<void> | null = null;
  private context: Promise<WhisperContextLike> | null = null;
  private progress: VoiceInputPrepareProgress | null = null;
  private readonly listeners = new Set<ProgressListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private activeUses = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves when a download lands, for checks waiting on someone else's download. */
  private readonly modelArrival = Promise.withResolvers<void>();

  constructor(dependencies: WhisperTranscriberDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Resolves once the model is on disk. Cancelling only stops the reporting;
   * the download continues for the next caller. Without `download` it reports
   * `ready`, or `missing` and then waits for someone else's download.
   */
  async prepare(
    onProgress: ProgressListener,
    signal?: AbortSignal,
    options: { readonly download?: boolean } = {},
  ): Promise<void> {
    if (options.download === false && !this.modelFile) {
      if (await this.dependencies.modelExists(this.dependencies.modelPath)) {
        onProgress(READY);
        return;
      }
      onProgress(MISSING);
    }
    this.listeners.add(onProgress);
    if (this.progress) onProgress(this.progress);
    try {
      await abortable(
        options.download === false ? this.modelArrival.promise : this.ensureModelFile(),
        signal,
      );
      onProgress(READY);
    } finally {
      this.listeners.delete(onProgress);
    }
  }

  /**
   * Transcribes 16 kHz mono PCM16 audio, loading the model first when needed.
   * `language` is a Whisper language code, or `auto` to detect it.
   */
  async transcribe(audio: ArrayBuffer, signal?: AbortSignal, language = "auto"): Promise<string> {
    this.activeUses += 1;
    this.clearIdleTimer();
    try {
      const run = this.queue.then(async () => {
        signal?.throwIfAborted();
        const context = await abortable(this.ensureContext(), signal);
        signal?.throwIfAborted();
        const { stop, promise } = context.transcribeData(audio, {
          language: resolveWhisperLanguage(language),
        });
        const onAbort = () => void stop();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await promise;
          signal?.throwIfAborted();
          return result.result.trim();
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      });
      this.queue = run.catch(() => undefined);
      return await run;
    } finally {
      this.releaseUse();
    }
  }

  private ensureModelFile(): Promise<void> {
    if (!this.modelFile) {
      const modelFile = this.downloadModelIfMissing();
      this.modelFile = modelFile;
      modelFile.then(this.modelArrival.resolve, () => {
        // A failed download is retried by the next caller.
        if (this.modelFile === modelFile) this.modelFile = null;
        this.progress = null;
      });
    }
    return this.modelFile;
  }

  private async downloadModelIfMissing(): Promise<void> {
    const { modelPath } = this.dependencies;
    if (await this.dependencies.modelExists(modelPath)) return;
    let reportedPercent: number | null = null;
    await this.dependencies.downloadModel(modelPath, (receivedBytes, totalBytes) => {
      // One update per percent keeps a 500 MB download from flooding the socket.
      const percent = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : -1;
      if (percent === reportedPercent) return;
      reportedPercent = percent;
      this.report({ phase: "downloading", receivedBytes, totalBytes });
    });
    this.progress = null;
  }

  private ensureContext(): Promise<WhisperContextLike> {
    if (!this.context) {
      const context = this.ensureModelFile().then(() =>
        this.dependencies.loadContext(this.dependencies.modelPath),
      );
      this.context = context;
      // A failed load is retried by the next dictation.
      context.catch(() => {
        if (this.context === context) this.context = null;
      });
    }
    return this.context;
  }

  private report(progress: VoiceInputPrepareProgress): void {
    this.progress = progress;
    for (const listener of this.listeners) listener(progress);
  }

  private releaseUse(): void {
    this.activeUses -= 1;
    if (this.activeUses > 0 || !this.context) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(
      () => void this.releaseIdleContext(),
      this.dependencies.idleReleaseMs,
    );
    this.idleTimer.unref?.();
  }

  private async releaseIdleContext(): Promise<void> {
    this.idleTimer = null;
    const context = this.context;
    if (this.activeUses > 0 || !context) return;
    this.context = null;
    try {
      await (await context).release();
    } catch {
      // A context that failed to load has nothing to release.
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

// The languages whisper.cpp knows; any other code makes it fail outright.
const WHISPER_LANGUAGES = new Set(
  (
    "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th " +
    "ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl " +
    "mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg " +
    "as tt haw ln ha ba jw su yue"
  ).split(" "),
);

/** A language hint Whisper understands, else `auto`. */
export function resolveWhisperLanguage(language: string): string {
  return WHISPER_LANGUAGES.has(language) ? language : "auto";
}

const READY: VoiceInputPrepareProgress = { phase: "ready", receivedBytes: 0, totalBytes: 0 };
const MISSING: VoiceInputPrepareProgress = { phase: "missing", receivedBytes: 0, totalBytes: 0 };

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
