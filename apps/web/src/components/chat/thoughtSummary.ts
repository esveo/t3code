/**
 * A turn's thinking, read back as a trail.
 *
 * Extractive on purpose: every beat is a sentence the agent wrote, never a
 * paraphrase. A trace is already written in paragraphs that open with their
 * point and then elaborate, so taking those openings in order reads like the
 * process without inventing a word of it, instantly and for free.
 *
 * What it cannot do, and the reader should know: it repeats a considered idea
 * as flatly as a decided one, and it cannot merge two paragraphs about the
 * same thing.
 */
export interface ThoughtTrail {
  readonly steps: ReadonlyArray<string>;
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
 * Turns whose thinking is finished and worth reading back.
 *
 * Deliberately no text: this runs on every streaming frame, so it counts what
 * is there and leaves the reading to the click. The live turn is left out,
 * because a trail of a trace that is still growing is stale the moment it is
 * read.
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

/**
 * One beat per paragraph of trace, whole sentences, nothing dropped for
 * length: the point is to see the process, and the popup scrolls.
 */
export function deriveThoughtTrail(text: string): ThoughtTrail {
  // Deduplicated: a trace repeats itself ("Let me check."), and a trail that
  // repeats reads as noise.
  const steps = [
    ...new Set(
      text
        .split(/\n\s*\n/)
        .map(toTrailStep)
        .filter((step) => step.length > 0),
    ),
  ];
  return { steps };
}

/** A paragraph of trace reduced to its opening sentence, without markdown. */
function toTrailStep(paragraph: string): string {
  const plain = paragraph.replace(/^[#>\s]*[-*+]?\s*/, "").replace(/[*_`]/g, "");
  const compact = plain.replace(/\s+/g, " ").trim();
  return compact.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? compact;
}
