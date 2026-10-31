import { observeResize } from "~/lib/observeResize";
import {
  VOICE_CALL_LEVEL_SAMPLE_MS,
  type VoiceCallLane,
  voiceCallLevelAt,
  voiceCallNow,
} from "./voiceCallLevels";
import type { VoiceCallTranscriptEntry } from "./voiceCallState";

/**
 * Fork: draws the call diagram on one canvas. React only hands over new data, so
 * the moving axis costs no renders and no layout, and only the visible window is
 * drawn; a long call costs the same as a short one.
 */
const BAR_PX = 3;
const BAR_WIDTH = 2;
const PX_PER_MS = BAR_PX / VOICE_CALL_LEVEL_SAMPLE_MS;
/** Matches the `h-8` lanes of VoiceCallTimeline. */
const LANE_HEIGHT = 32;
const PILL_HEIGHT = 10;
const PILL_RADIUS = 3;
const PILL_GAP = 3;
const PILL_MIN_WIDTH = 6;
const WAVE_MAX_HEIGHT = 22;
const QUIET_ALPHA = 0.5;
const HOVER_ALPHA = 0.25;
const HOVER_PADDING_PX = 6;
const HOVER_RADIUS = 6;
const CURSOR_ALPHA = 0.25;
const LANE_COUNT = 3;
const DASH_PX = 6;
const DASH_WIDTH = 2;
const DASH_ALPHA = 0.3;
const CAPTION_TURNS = 3;
const FRAME_MS = 33;
/** Above the noise floor of an open microphone; a tuning value, not a law. */
const LOUD_LEVEL = 0.18;
/** The shortest bar, so quiet syllables do not shrink to dots. */
const MIN_BAR_LEVEL = 0.3;
/** Dips this short between loud bars are drawn too, so speech reads as one wave. */
const BRIDGE_BARS = 3;
/** Quiet bars a sentence may pause for and still count as one section. */
const GAP_BARS = 8;
/** The transcript starts well after the first word, so its section looks back this far. */
const LOOKBACK_BARS = 80;

export interface DiagramSection {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface DiagramSpeech extends DiagramSection {
  readonly turnId: string;
}

export interface VoiceCallSpeechHover {
  readonly turnId: string;
  readonly clientX: number;
  readonly clientY: number;
}

export interface DiagramBlock extends DiagramSection {
  /** When the agent began each step of this work. */
  readonly stepStarts: ReadonlyArray<number>;
  readonly failed: boolean;
  readonly messageId: string | null;
}

export interface DiagramColors {
  readonly user: string;
  readonly voice: string;
  readonly thread: string;
  readonly foreground: string;
  readonly destructive: string;
}

export interface DiagramData {
  readonly startedAt: number;
  readonly user: ReadonlyArray<DiagramSpeech>;
  readonly voice: ReadonlyArray<DiagramSpeech>;
  readonly blocks: ReadonlyArray<DiagramBlock>;
}

const bucketOf = (at: number) => Math.floor(at / VOICE_CALL_LEVEL_SAMPLE_MS);

/**
 * Where a turn is really audible. Its events arrive late on both ends, so the
 * levels decide; without any (another client's call) the events are all there is.
 */
export function speechBounds(
  levelAt: (bucket: number) => number,
  turn: {
    readonly start: number;
    readonly end: number;
    readonly floor: number;
    readonly ceiling: number;
  },
): { readonly first: number; readonly last: number } {
  const loud = (bucket: number) => levelAt(bucket) >= LOUD_LEVEL;
  const stop = Math.max(turn.floor, turn.start - LOOKBACK_BARS);
  let first: number | null = null;
  let gap = 0;
  for (let bucket = turn.start; bucket >= stop && gap <= GAP_BARS; bucket--) {
    if (loud(bucket)) {
      first = bucket;
      gap = 0;
    } else {
      gap++;
    }
  }
  for (let bucket = turn.start + 1; first === null && bucket <= turn.end; bucket++) {
    if (loud(bucket)) first = bucket;
  }
  if (first === null) return { first: turn.start, last: turn.end };
  let last = first;
  gap = 0;
  // The voice's audio plays on after its turn is done, so this may pass `end`.
  for (let bucket = first + 1; bucket <= turn.ceiling; bucket++) {
    if (loud(bucket)) {
      last = bucket;
      gap = 0;
    } else if (++gap > GAP_BARS && bucket >= turn.end) {
      break;
    }
  }
  return { first, last };
}

/** Each turn's audible span, in order: a turn starts only after the one before it ended. */
export function voiceCallSpeechSpans(
  levelAt: (bucket: number) => number,
  sections: ReadonlyArray<DiagramSpeech>,
  startBucket: number,
  nowBucket: number,
) {
  const spans: Array<{ readonly turnId: string; readonly first: number; readonly last: number }> =
    [];
  let floor = startBucket;
  sections.forEach((section, index) => {
    const next = sections[index + 1];
    const start = bucketOf(section.startedAt);
    const bounds = speechBounds(levelAt, {
      start,
      end: section.endedAt === null ? nowBucket : bucketOf(section.endedAt),
      floor,
      ceiling: next === undefined ? nowBucket : Math.max(start, bucketOf(next.startedAt) - 1),
    });
    spans.push({ turnId: section.turnId, ...bounds });
    floor = bounds.last + 1;
  });
  return spans;
}

/** The bars of a lane: loud buckets, plus the short dips between them. */
export function voiceCallBars(levelAt: (bucket: number) => number, from: number, to: number) {
  const bars: Array<{ readonly bucket: number; readonly level: number }> = [];
  let lastLoud: number | null = null;
  for (let bucket = from; bucket <= to; bucket++) {
    const level = levelAt(bucket);
    if (level < LOUD_LEVEL) continue;
    if (lastLoud !== null && bucket - lastLoud - 1 <= BRIDGE_BARS) {
      for (let dip = lastLoud + 1; dip < bucket; dip++) {
        bars.push({ bucket: dip, level: MIN_BAR_LEVEL });
      }
    }
    bars.push({ bucket, level: Math.max(level, MIN_BAR_LEVEL) });
    lastLoud = bucket;
  }
  return bars;
}

/** The turns the caption shows and who it highlights: who speaks, else who spoke last. */
export function voiceCallCaption(transcript: ReadonlyArray<VoiceCallTranscriptEntry>) {
  const turns = transcript
    .filter((entry) => entry.endedAt === null || entry.text !== "")
    .slice(-CAPTION_TURNS);
  const current = turns.findLast((entry) => entry.endedAt === null) ?? turns.at(-1);
  return { turns, currentTurnId: current?.turnId ?? null };
}

/** One pill per step: each runs until the next step starts, the last until the block ends. */
export function voiceCallPills(block: DiagramBlock, end: number): ReadonlyArray<DiagramSection> {
  const starts = [
    block.startedAt,
    ...block.stepStarts.filter((at) => at > block.startedAt && at < end).toSorted((a, b) => a - b),
  ];
  return starts.map((startedAt, index) => ({ startedAt, endedAt: starts[index + 1] ?? end }));
}

interface Hit {
  readonly x: number;
  readonly width: number;
  readonly messageId: string;
}

function drawDiagram(
  context: CanvasRenderingContext2D,
  input: {
    readonly data: DiagramData;
    readonly colors: DiagramColors;
    readonly width: number;
    readonly height: number;
    readonly now: number;
    readonly pan: number;
    readonly moving: boolean;
    readonly pointer: { readonly x: number; readonly y: number } | null;
  },
): { readonly hits: ReadonlyArray<Hit>; readonly hoveredTurnId: string | null } {
  const { data, colors, width, height, now, moving, pointer } = input;
  let hoveredTurnId: string | null = null;
  const cursor = now - input.pan;
  const xOf = (at: number) => width / 2 + (at - cursor) * PX_PER_MS;
  const nowBucket = bucketOf(now);
  const startBucket = bucketOf(data.startedAt);
  const firstVisible = Math.max(startBucket, bucketOf(cursor - width / 2 / PX_PER_MS));
  const lastVisible = Math.min(nowBucket - 1, bucketOf(cursor + width / 2 / PX_PER_MS) + 1);
  context.clearRect(0, 0, width, height);

  /** Where the lane's live speech starts, if someone is speaking in it right now. */
  const liveFrom = (lane: VoiceCallLane, sections: ReadonlyArray<DiagramSection>) => {
    const section = sections.at(-1);
    if (!moving || section === undefined) return Infinity;
    const previous = sections.at(-2);
    const bounds = speechBounds((bucket) => voiceCallLevelAt(lane, bucket), {
      start: bucketOf(section.startedAt),
      end: section.endedAt === null ? nowBucket : bucketOf(section.endedAt),
      floor: previous?.endedAt ? bucketOf(previous.endedAt) + 1 : startBucket,
      ceiling: nowBucket,
    });
    return section.endedAt === null || nowBucket - bounds.last <= GAP_BARS
      ? bounds.first
      : Infinity;
  };

  context.lineCap = "round";
  context.lineWidth = BAR_WIDTH;
  const drawLane = (
    lane: VoiceCallLane,
    sections: ReadonlyArray<DiagramSpeech>,
    color: string,
    top: number,
  ) => {
    const middle = top + LANE_HEIGHT / 2;
    // One stroked path per opacity, so round bars cost no more than square ones.
    const strokeBars = (from: number, to: number, alpha: number) => {
      context.globalAlpha = alpha;
      context.beginPath();
      for (const { bucket, level } of voiceCallBars((at) => voiceCallLevelAt(lane, at), from, to)) {
        const reach = Math.max(0.5, (level * WAVE_MAX_HEIGHT - BAR_WIDTH) / 2);
        const x = Math.round(xOf(bucket * VOICE_CALL_LEVEL_SAMPLE_MS));
        context.moveTo(x, middle - reach);
        context.lineTo(x, middle + reach);
      }
      context.stroke();
    };
    const live = liveFrom(lane, sections);
    const hovered =
      pointer === null || pointer.y < top || pointer.y >= top + LANE_HEIGHT
        ? undefined
        : voiceCallSpeechSpans(
            (bucket) => voiceCallLevelAt(lane, bucket),
            sections,
            startBucket,
            nowBucket,
          ).find(({ first, last }) => {
            const from = xOf(first * VOICE_CALL_LEVEL_SAMPLE_MS) - HOVER_PADDING_PX;
            const to = xOf(last * VOICE_CALL_LEVEL_SAMPLE_MS) + HOVER_PADDING_PX;
            return pointer.x >= from && pointer.x <= to;
          });
    context.strokeStyle = color;
    if (hovered !== undefined) {
      hoveredTurnId = hovered.turnId;
      const x = xOf(hovered.first * VOICE_CALL_LEVEL_SAMPLE_MS) - HOVER_PADDING_PX;
      const right = xOf(hovered.last * VOICE_CALL_LEVEL_SAMPLE_MS) + HOVER_PADDING_PX;
      context.globalAlpha = HOVER_ALPHA;
      context.fillStyle = color;
      context.beginPath();
      context.roundRect(x, top + 1, right - x, LANE_HEIGHT - 2, HOVER_RADIUS);
      context.fill();
    }
    strokeBars(firstVisible, Math.min(lastVisible, live - 1), QUIET_ALPHA);
    strokeBars(Math.max(firstVisible, live), lastVisible, 1);
    if (hovered !== undefined) strokeBars(hovered.first, hovered.last, 1);
    context.globalAlpha = 1;
  };

  // A dashed middle line in every lane keeps the axis visibly moving while nobody speaks.
  context.fillStyle = colors.foreground;
  context.globalAlpha = DASH_ALPHA;
  const dashMs = DASH_PX / PX_PER_MS;
  const lastDash = Math.floor((cursor + width / 2 / PX_PER_MS - data.startedAt) / dashMs);
  const firstDash = Math.max(0, lastDash - Math.ceil(width / DASH_PX) - 1);
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const y = lane * LANE_HEIGHT + LANE_HEIGHT / 2;
    for (let dash = firstDash; dash <= lastDash; dash++) {
      context.fillRect(Math.round(xOf(data.startedAt + dash * dashMs)), y, DASH_WIDTH, 1);
    }
  }
  context.globalAlpha = 1;

  drawLane("user", data.user, colors.user, 0);
  drawLane("voice", data.voice, colors.voice, LANE_HEIGHT);

  const hits: Array<Hit> = [];
  const top = LANE_HEIGHT * 2;
  const pillY = top + (LANE_HEIGHT - PILL_HEIGHT) / 2;
  for (const block of data.blocks) {
    const end = block.endedAt ?? now;
    const left = Math.round(xOf(block.startedAt));
    const right = xOf(end);
    if (left > width || right < 0) continue;
    if (block.messageId !== null) {
      hits.push({
        x: left,
        width: Math.max(PILL_MIN_WIDTH, right - left),
        messageId: block.messageId,
      });
    }
    context.globalAlpha = block.endedAt === null || block.failed ? 1 : QUIET_ALPHA;
    context.fillStyle = block.failed ? colors.destructive : colors.thread;
    for (const pill of voiceCallPills(block, end)) {
      const x = Math.round(xOf(pill.startedAt));
      const pillWidth = Math.max(PILL_MIN_WIDTH, xOf(pill.endedAt ?? end) - x - PILL_GAP);
      if (x > width || x + pillWidth < 0) continue;
      // Keeps the lane's dashed line out of the half-transparent pills.
      context.clearRect(x, pillY, pillWidth, PILL_HEIGHT);
      context.beginPath();
      context.roundRect(x, pillY, pillWidth, PILL_HEIGHT, PILL_RADIUS);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  context.globalAlpha = CURSOR_ALPHA;
  context.fillStyle = colors.foreground;
  context.fillRect(Math.round(width / 2), 0, 1, height);
  context.globalAlpha = 1;
  return { hits, hoveredTurnId };
}

/** Runs the canvas until the returned cleanup; it only keeps redrawing while the clock moves. */
export function runVoiceCallDiagram(
  canvas: HTMLCanvasElement,
  input: {
    readonly data: DiagramData;
    readonly colors: DiagramColors;
    readonly moving: boolean;
    /** Survives data updates, so new text does not jump the view back or drop the hover. */
    readonly view: { pan: number; pointer: { x: number; y: number } | null };
    readonly onOpenMessage: (messageId: string) => void;
    /** Fires when the hovered turn changes, also when speech moves under a resting pointer. */
    readonly onHoverSpeech: (hover: VoiceCallSpeechHover | null) => void;
  },
): () => void {
  const { data, colors, moving, view } = input;
  const context = canvas.getContext("2d", { alpha: true });
  if (context === null) return () => {};
  let width = 0;
  let height = 0;
  let hits: ReadonlyArray<Hit> = [];
  let hoveredTurnId: string | null = null;
  let frame: number | null = null;
  let lastFrameAt = 0;

  const draw = () => {
    if (width === 0) return;
    const scale = window.devicePixelRatio;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const drawn = drawDiagram(context, {
      data,
      colors,
      width,
      height,
      now: voiceCallNow(),
      pan: view.pan,
      moving,
      pointer: view.pointer,
    });
    hits = drawn.hits;
    if (drawn.hoveredTurnId !== hoveredTurnId) {
      hoveredTurnId = drawn.hoveredTurnId;
      const { left, top } = canvas.getBoundingClientRect();
      input.onHoverSpeech(
        hoveredTurnId === null || view.pointer === null
          ? null
          : {
              turnId: hoveredTurnId,
              clientX: left + view.pointer.x,
              clientY: top + Math.floor(view.pointer.y / LANE_HEIGHT) * LANE_HEIGHT,
            },
      );
    }
  };
  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * window.devicePixelRatio);
    canvas.height = Math.round(height * window.devicePixelRatio);
    draw();
  };
  const tick = (at: number) => {
    frame = requestAnimationFrame(tick);
    if (at - lastFrameAt < FRAME_MS) return;
    lastFrameAt = at;
    draw();
  };
  const hitAt = (event: MouseEvent) => {
    const { left, top } = canvas.getBoundingClientRect();
    const x = event.clientX - left;
    return event.clientY - top < LANE_HEIGHT * 2
      ? undefined
      : hits.find((hit) => x >= hit.x && x <= hit.x + hit.width);
  };
  const onClick = (event: MouseEvent) => {
    const hit = hitAt(event);
    if (hit !== undefined) input.onOpenMessage(hit.messageId);
  };
  const onMove = (event: MouseEvent) => {
    canvas.style.cursor = hitAt(event) === undefined ? "" : "pointer";
    const { left, top } = canvas.getBoundingClientRect();
    view.pointer = { x: event.clientX - left, y: event.clientY - top };
    draw();
  };
  const onLeave = () => {
    view.pointer = null;
    draw();
  };
  const onWheel = (event: WheelEvent) => {
    if (moving) return;
    const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
    const furthest = voiceCallNow() - data.startedAt;
    view.pan = Math.min(furthest, Math.max(0, view.pan + delta / PX_PER_MS));
    draw();
  };

  const stopObserving = observeResize(canvas, resize);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: true });
  if (moving) {
    view.pan = 0;
    frame = requestAnimationFrame(tick);
  }
  draw();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    stopObserving();
    canvas.removeEventListener("click", onClick);
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("mouseleave", onLeave);
    canvas.removeEventListener("wheel", onWheel);
    input.onHoverSpeech(null);
  };
}
