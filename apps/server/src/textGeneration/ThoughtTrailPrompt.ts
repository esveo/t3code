import * as Schema from "effect/Schema";

/**
 * How much of a trace the summarizer sees.
 *
 * Generous next to the title budget, because the whole point is the long ones,
 * and still small enough to stay a cheap call on a small model.
 */
const MAX_TRACE_CHARS = 24_000;
const OMITTED_MIDDLE = "\n\n[Middle of the trace omitted]\n\n";

const MAX_TRAIL_STEPS = 6;
const MAX_STEP_CHARS = 200;

/**
 * Both ends of a trace carry the reading: how the agent went in, and where it
 * came out. A tail-only budget would lose the question it started from.
 */
export function limitThoughtTrace(trace: string): string {
  const trimmed = trace.trim();
  if (trimmed.length <= MAX_TRACE_CHARS) {
    return trimmed;
  }
  const keep = Math.floor((MAX_TRACE_CHARS - OMITTED_MIDDLE.length) / 2);
  return `${trimmed.slice(0, keep).trimEnd()}${OMITTED_MIDDLE}${trimmed.slice(-keep).trimStart()}`;
}

export function buildThoughtTrailPrompt(input: { readonly trace: string }) {
  const prompt = [
    "You compact an AI coding agent's thinking into a short trail a person can skim.",
    "Return a JSON object with keys: steps (array of strings), outcome (string).",
    "Rules:",
    "- steps: three to six beats, in the order they happened, one short sentence each.",
    "- A beat says what was considered, found, or decided, not that thinking happened.",
    "- Keep the agent's own nouns: file names, symbols, commands, numbers.",
    "- outcome: one sentence for where the thinking landed.",
    "- Use only what the trace says. Invent nothing, and do not mention the trace or yourself.",
    "- Plain sentences, no markdown, no numbering.",
    "",
    "Thinking trace:",
    limitThoughtTrace(input.trace),
  ].join("\n");

  const outputSchema = Schema.Struct({
    steps: Schema.Array(Schema.String),
    outcome: Schema.String,
  });

  return { prompt, outputSchema };
}

/** Models pad and repeat; the UI has room for a handful of short beats. */
export function sanitizeThoughtTrail(generated: {
  readonly steps: ReadonlyArray<string>;
  readonly outcome: string;
}): { steps: ReadonlyArray<string>; outcome: string | null } {
  const steps: string[] = [];
  for (const step of generated.steps) {
    const beat = compactBeat(step);
    if (beat !== null && !steps.includes(beat) && steps.length < MAX_TRAIL_STEPS) {
      steps.push(beat);
    }
  }
  return { steps, outcome: compactBeat(generated.outcome) };
}

function compactBeat(text: string): string | null {
  const compact = text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length === 0) {
    return null;
  }
  return compact.length > MAX_STEP_CHARS
    ? `${compact.slice(0, MAX_STEP_CHARS - 1).trimEnd()}…`
    : compact;
}
