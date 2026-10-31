/**
 * Fork: how loud the user and the voice are, sampled for the call diagram. Only
 * the client carrying the call has the audio, so other clients draw no waves.
 */
export type VoiceCallLane = "user" | "voice";

export const VOICE_CALL_LEVEL_SAMPLE_MS = 125;

const samples: Record<VoiceCallLane, Map<number, number>> = { user: new Map(), voice: new Map() };
const sources: Partial<Record<VoiceCallLane, MediaStreamAudioSourceNode>> = {};
const analysers: Partial<Record<VoiceCallLane, AnalyserNode>> = {};
const frames: Partial<Record<VoiceCallLane, Float32Array<ArrayBuffer>>> = {};
let context: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastBucket: number | null = null;
const MAX_FILLED_BUCKETS = 8;

/** The diagram's time: it stands still while the call does not run, so a pause leaves no gap. */
let clockOffset = 0;
let frozenAt: number | null = 0;

export const voiceCallNow = () => frozenAt ?? Date.now() - clockOffset;

// ponytail: uses the current offset, so times before a pause shift by its length; keep per-segment offsets if that shows.
export const voiceCallTimeOf = (wallClockMs: number) => wallClockMs - clockOffset;

export function syncVoiceCallClock(moving: boolean) {
  if (moving && frozenAt !== null) {
    clockOffset = Date.now() - frozenAt;
    frozenAt = null;
  } else if (!moving && frozenAt === null) {
    frozenAt = Date.now() - clockOffset;
  }
}

const sample = () => {
  if (frozenAt !== null) return;
  const bucket = Math.floor(voiceCallNow() / VOICE_CALL_LEVEL_SAMPLE_MS);
  // The timer runs late now and then and would leave empty buckets, which draw as gaps.
  const firstBucket =
    lastBucket !== null && bucket - lastBucket <= MAX_FILLED_BUCKETS ? lastBucket + 1 : bucket;
  lastBucket = bucket;
  for (const lane of ["user", "voice"] as const) {
    const analyser = analysers[lane];
    const frame = frames[lane];
    if (analyser === undefined || frame === undefined) continue;
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (const value of frame) sum += value * value;
    const level = Math.min(1, Math.sqrt(Math.sqrt(sum / frame.length)) * 1.5);
    for (let filled = firstBucket; filled <= bucket; filled++) samples[lane].set(filled, level);
  }
};

export function clearVoiceCallLevels() {
  samples.user.clear();
  samples.voice.clear();
}

/** Must run inside the click handler, or the browser keeps the context suspended. */
export function startVoiceCallLevels() {
  stopVoiceCallLevels();
  context = new AudioContext();
  void context.resume();
  timer = setInterval(sample, VOICE_CALL_LEVEL_SAMPLE_MS);
}

/** A retried connection brings a new remote stream, which replaces the old one. */
export function setVoiceCallLevelSource(lane: VoiceCallLane, stream: MediaStream) {
  if (context === null) return;
  sources[lane]?.disconnect();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  source.connect(analyser);
  sources[lane] = source;
  analysers[lane] = analyser;
  frames[lane] = new Float32Array(analyser.fftSize);
}

export function stopVoiceCallLevels() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  void context?.close();
  context = null;
  delete sources.user;
  delete sources.voice;
  delete analysers.user;
  delete analysers.voice;
}

export const voiceCallLevelAt = (lane: VoiceCallLane, bucket: number) =>
  samples[lane].get(bucket) ?? 0;
