/**
 * The thinking a turn produced, compacted into a short trail.
 *
 * The trail is what the reader gets instead of scrolling a thousand lines of
 * trace: a handful of beats in order, and where it came out.
 */
export interface ThoughtTrail {
  readonly steps: ReadonlyArray<string>;
  readonly outcome: string | null;
}

export interface ThoughtTrailSource {
  /** One trail per thread turn: also the reset signal when the turn changes. */
  readonly key: string;
  readonly text: string;
}

/**
 * Every reasoning message of a turn as one blob, or null when there is nothing
 * worth recapping. Gated on the turn having settled, because a trail built
 * from a trace that is still growing is stale the moment it is read.
 */
export function resolveThoughtTrailSource(input: {
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly turnId: string | null;
  }>;
  readonly turnId: string | null;
  readonly settled: boolean;
  readonly keyPrefix: string;
}): ThoughtTrailSource | null {
  if (!input.settled || input.turnId === null) {
    return null;
  }

  const text = input.messages
    .filter((message) => message.role === "reasoning" && message.turnId === input.turnId)
    .map((message) => message.text.trim())
    .filter((trace) => trace.length > 0)
    .join("\n\n");

  return text.length === 0 ? null : { key: `${input.keyPrefix}:${input.turnId}`, text };
}

const MAX_TRAIL_STEPS = 7;
const MAX_STEP_CHARS = 150;
const STUB_LATENCY_MS = 700;

/**
 * PROTOTYPE. Stands in for the provider's cheap one-shot summarizer until that
 * server operation exists, so the interaction can be judged first. It picks
 * beats out of the real trace instead of inventing text, and takes long enough
 * that the pending state is visible.
 */
export function generateStubThoughtTrail(text: string): Promise<ThoughtTrail> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(deriveStubThoughtTrail(text)), STUB_LATENCY_MS);
  });
}

export function deriveStubThoughtTrail(text: string): ThoughtTrail {
  // Deduplicated: a trace repeats itself ("Let me check."), and a trail that
  // repeats reads as noise.
  const beats = [
    ...new Set(
      text
        .split(/\n\s*\n/)
        .map(toTrailStep)
        .filter((step) => step.length > 0),
    ),
  ];
  if (beats.length === 0) {
    return { steps: [], outcome: null };
  }

  const picked = beats.length <= MAX_TRAIL_STEPS ? beats : sampleEvenly(beats, MAX_TRAIL_STEPS);
  return { steps: picked.slice(0, -1), outcome: picked.at(-1) ?? null };
}

/** Keeps the first and last beat and spreads the rest, so the trail spans the trace. */
function sampleEvenly(items: ReadonlyArray<string>, count: number): string[] {
  const picked: string[] = [];
  for (let step = 0; step < count; step += 1) {
    const item = items[Math.round((step * (items.length - 1)) / (count - 1))];
    if (item !== undefined && picked.at(-1) !== item) {
      picked.push(item);
    }
  }
  return picked;
}

/** A paragraph of trace reduced to its opening sentence, without markdown. */
function toTrailStep(paragraph: string): string {
  const plain = paragraph.replace(/^[#>\s]*[-*+]?\s*/, "").replace(/[*_`]/g, "");
  const compact = plain.replace(/\s+/g, " ").trim();
  const sentence = compact.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? compact;
  return sentence.length > MAX_STEP_CHARS
    ? `${sentence.slice(0, MAX_STEP_CHARS - 1).trimEnd()}…`
    : sentence;
}
