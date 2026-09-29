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

/**
 * A timeline entry, narrowed to the part a trail is built from: V2 records
 * thinking as `reasoning` work items, each carrying its run and its text.
 */
export interface ThoughtEntry {
  readonly kind: string;
  readonly entry?:
    | {
        readonly itemType?: string | undefined;
        readonly runId?: string | null | undefined;
        readonly detail?: string | undefined;
      }
    | undefined;
}

/** The run and trace of a reasoning entry, or null for anything else. */
function reasoningOf(entry: ThoughtEntry): { runId: string; text: string } | null {
  const work = entry.kind === "work" ? entry.entry : undefined;
  if (work?.itemType !== "reasoning" || work.runId == null) return null;
  return { runId: work.runId, text: work.detail ?? "" };
}

/**
 * Runs whose thinking is finished and worth reading back.
 *
 * Deliberately no text: this runs on every streaming frame, so it counts what
 * is there and leaves the reading to the click. The live run is left out,
 * because a trail of a trace that is still growing is stale the moment it is
 * read.
 */
export function deriveTurnsWithThoughts(
  entries: ReadonlyArray<ThoughtEntry>,
  skipRunId: string | null,
): ReadonlySet<string> {
  const runs = new Set<string>();
  for (const entry of entries) {
    const reasoning = reasoningOf(entry);
    if (reasoning !== null && reasoning.runId !== skipRunId && reasoning.text.trim().length > 0) {
      runs.add(reasoning.runId);
    }
  }
  return runs;
}

/** Every reasoning item of one run, in order, as one blob. */
export function readTurnThoughts(entries: ReadonlyArray<ThoughtEntry>, runId: string): string {
  const traces: string[] = [];
  for (const entry of entries) {
    const reasoning = reasoningOf(entry);
    if (reasoning?.runId === runId) {
      const trace = reasoning.text.trim();
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
