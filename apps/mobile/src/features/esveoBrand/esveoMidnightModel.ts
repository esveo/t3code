/**
 * Fork: the pure half of esveo Midnight's brand gradients on mobile, ported
 * from apps/web/src/components/esveoBrand/esveoMidnight.css. The colours are
 * the web tile's, with its oklch stops converted to sRGB hex.
 */

export const ESVEO_MIDNIGHT_THEME_ID = "esveo-midnight";

export const ESVEO_SKY = "#03a8ff";
export const ESVEO_SKY_SEA = "#35c6ef";
export const ESVEO_SEA = "#68e5de";

/** The tile's base: Space navy into Sky ink (oklch 0.245/0.345/0.45 on web). */
export const ESVEO_TILE_STOPS = ["#161e3b", "#033b68", "#005a94"] as const;

/** The send button's Sky gradient, running into the Sky-Sea mid. */
export const ESVEO_ACTION_STOPS = ["#0a97ef", ESVEO_SKY, ESVEO_SKY_SEA] as const;

/** The faint even ring under the circling light: Sky at 22%. */
export const ESVEO_LIVE_RING_BASE = "rgba(3, 168, 255, 0.22)";

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function hex(value: string, a = 1): Rgba {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
    a,
  };
}

/** The web ring's conic-gradient stops, in degrees clockwise from the top. */
const CONIC_STOPS: ReadonlyArray<readonly [number, Rgba]> = [
  [0, TRANSPARENT],
  [80, hex(ESVEO_SKY, 0.18)],
  [150, TRANSPARENT],
  [190, TRANSPARENT],
  [285, hex(ESVEO_SKY, 0.65)],
  [330, hex(ESVEO_SKY_SEA)],
  [352, hex(ESVEO_SEA)],
  [358, hex("#ffffff", 0.85)],
  [360, TRANSPARENT],
];

/**
 * The ring's colour at an angle. Like CSS, it interpolates premultiplied, so
 * fading into `transparent` fades the alpha without darkening the colour.
 */
export function sampleEsveoConic(angle: number): Rgba {
  const upper = CONIC_STOPS.findIndex(([at]) => at >= angle);
  if (upper <= 0) return CONIC_STOPS[0]![1];
  const [fromAt, from] = CONIC_STOPS[upper - 1]!;
  const [toAt, to] = CONIC_STOPS[upper]!;
  const t = (angle - fromAt) / (toAt - fromAt);
  const a = from.a + (to.a - from.a) * t;
  if (a === 0) return TRANSPARENT;
  const channel = (key: "r" | "g" | "b") =>
    Math.round((from[key] * from.a + (to[key] * to.a - from[key] * from.a) * t) / a);
  return { r: channel("r"), g: channel("g"), b: channel("b"), a };
}

export interface EsveoConicWedge {
  readonly path: string;
  readonly fill: string;
  readonly opacity: number;
}

const WEDGE_STEP_DEGREES = 3;
// Each wedge reaches a little into the next, so no seam shows between them.
const WEDGE_OVERLAP_DEGREES = 0.6;

function point(angle: number): string {
  const radians = (angle * Math.PI) / 180;
  return `${Math.sin(radians).toFixed(4)} ${(-Math.cos(radians)).toFixed(4)}`;
}

/**
 * react-native-svg has no conic gradient, so the ring's light is drawn as
 * thin pie wedges in a unit circle (viewBox -1 -1 2 2), each filled with the
 * colour at its middle. Fully transparent wedges are left out.
 */
export function buildEsveoConicWedges(): ReadonlyArray<EsveoConicWedge> {
  const wedges: EsveoConicWedge[] = [];
  for (let start = 0; start < 360; start += WEDGE_STEP_DEGREES) {
    const color = sampleEsveoConic(start + WEDGE_STEP_DEGREES / 2);
    if (color.a < 0.005) continue;
    const end = Math.min(start + WEDGE_STEP_DEGREES + WEDGE_OVERLAP_DEGREES, 360);
    wedges.push({
      path: `M0 0L${point(start)}A1 1 0 0 1 ${point(end)}Z`,
      fill: `rgb(${color.r}, ${color.g}, ${color.b})`,
      opacity: Number(color.a.toFixed(3)),
    });
  }
  return wedges;
}

// The user message whose turn is running. Its bubble reads this itself, so
// the feed's rows never re-render for it. Counted, because two panes can show
// the same thread.
const liveUserMessageCounts = new Map<string, number>();
const liveUserMessageListeners = new Set<() => void>();

function emitLiveUserMessages() {
  for (const listener of liveUserMessageListeners) listener();
}

export function markEsveoLiveUserMessage(messageId: string): () => void {
  liveUserMessageCounts.set(messageId, (liveUserMessageCounts.get(messageId) ?? 0) + 1);
  emitLiveUserMessages();
  return () => {
    const count = (liveUserMessageCounts.get(messageId) ?? 1) - 1;
    if (count > 0) liveUserMessageCounts.set(messageId, count);
    else liveUserMessageCounts.delete(messageId);
    emitLiveUserMessages();
  };
}

export function subscribeEsveoLiveUserMessages(listener: () => void): () => void {
  liveUserMessageListeners.add(listener);
  return () => {
    liveUserMessageListeners.delete(listener);
  };
}

export function isEsveoLiveUserMessage(messageId: string): boolean {
  return liveUserMessageCounts.has(messageId);
}
