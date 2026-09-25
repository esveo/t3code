import { VOICE_INPUT_SAMPLE_RATE } from "@t3tools/contracts";

export interface VoiceRecording {
  /** Current input loudness between 0 and 1, for the level meter. */
  readonly level: () => number;
  /** Ends the recording and returns it as the browser encoded it. */
  readonly stop: () => Promise<Blob>;
  readonly cancel: () => void;
}

/**
 * AAC in MP4, which afconvert and ffmpeg decode on the server. Chromium,
 * Electron and Safari record it; Chromium's WebM and MP4 with Opus are not
 * readable by afconvert. Without it the recording is sent as PCM instead.
 */
const COMPRESSED_MIME_TYPE = "audio/mp4;codecs=mp4a.40.2";

/** Whether a recording can travel compressed as `m4a`. */
export function isM4aRecording(recording: Blob): boolean {
  return recording.type.startsWith("audio/mp4") && recording.type.includes("mp4a");
}

/**
 * Records the microphone with MediaRecorder, which every browser and Electron
 * support.
 */
export async function startVoiceRecording(): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Browsers only expose the microphone to HTTPS and localhost pages.
    throw new Error("The microphone needs a secure connection (HTTPS or localhost).");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  let meterContext: AudioContext;
  try {
    recorder = new MediaRecorder(
      stream,
      MediaRecorder.isTypeSupported(COMPRESSED_MIME_TYPE)
        ? { mimeType: COMPRESSED_MIME_TYPE, audioBitsPerSecond: 64_000 }
        : undefined,
    );
    meterContext = new AudioContext();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
  const analyser = meterContext.createAnalyser();
  analyser.fftSize = 1024;
  meterContext.createMediaStreamSource(stream).connect(analyser);
  const meterBuffer = new Float32Array(analyser.fftSize);

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  recorder.start();

  const release = () => {
    if (recorder.state !== "inactive") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
    void meterContext.close().catch(() => {});
  };

  return {
    level: () => {
      analyser.getFloatTimeDomainData(meterBuffer);
      let sum = 0;
      for (const sample of meterBuffer) sum += sample * sample;
      // Speech sits around 0.02 to 0.2 RMS; stretch that range over the meter.
      return Math.min(1, Math.sqrt(sum / meterBuffer.length) * 6);
    },
    stop: async () => {
      release();
      await stopped;
      return new Blob(chunks, { type: recorder.mimeType });
    },
    cancel: release,
  };
}

/**
 * Decodes a recording to 16 kHz mono samples. Decoding into a 16 kHz context
 * resamples it to what Whisper expects without any audio processing of our own.
 */
export async function decodeVoiceRecording(recording: Blob): Promise<Float32Array> {
  const decoder = new OfflineAudioContext(1, 1, VOICE_INPUT_SAMPLE_RATE);
  const audio = await decoder.decodeAudioData(await recording.arrayBuffer());
  return mixToMono(audio);
}

function mixToMono(audio: AudioBuffer): Float32Array {
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const data = audio.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / audio.numberOfChannels;
    }
  }
  return mono;
}
