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

/** A timeline entry, narrowed to the part a trail is built from. */
export interface ThoughtEntry {
  readonly kind: string;
  readonly message?:
    | {
        readonly role: string;
        readonly text: string;
        readonly turnId: string | null;
      }
    | undefined;
}

/**
 * Turns whose thinking is finished and worth recapping.
 *
 * Deliberately no text: this runs on every streaming frame, so it counts what
 * is there and leaves the concatenating to the click. The live turn is left
 * out, because a recap of a trace that is still growing is stale the moment it
 * is read.
 */
export function deriveTurnsWithThoughts(
  entries: ReadonlyArray<ThoughtEntry>,
  skipTurnId: string | null,
): ReadonlySet<string> {
  const turns = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    if (
      message?.role === "reasoning" &&
      message.turnId !== null &&
      message.turnId !== skipTurnId &&
      message.text.trim().length > 0
    ) {
      turns.add(message.turnId);
    }
  }
  return turns;
}

/** Every reasoning message of one turn, in order, as one blob. */
export function readTurnThoughts(entries: ReadonlyArray<ThoughtEntry>, turnId: string): string {
  const traces: string[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === "reasoning" && message.turnId === turnId) {
      const trace = message.text.trim();
      if (trace.length > 0) {
        traces.push(trace);
      }
    }
  }
  return traces.join("\n\n");
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
