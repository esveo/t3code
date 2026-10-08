/**
 * Fork: user insights. The texts and output schemas of the Haiku calls. Kept
 * short and stable: the CLI's own system prompt already dominates the cost.
 */
import type { UserInsightsProfile, UserInsightsTraitId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { EvidenceRecord } from "./evidence.ts";

/** Most excerpts one distill shows the model, newest first. */
export const DISTILL_MAX_EXCERPTS = 30;
/** Rough budget of the excerpt section, about 6k tokens. */
export const DISTILL_EXCERPT_CHAR_BUDGET = 24_000;

export const TRAIT_DEFINITIONS: Record<UserInsightsTraitId, string> = {
  "style.language": "Which languages they write in, and for what (chat, code, commits).",
  "style.length": "How long their messages usually are.",
  "style.tone": "Their tone: terse or chatty, formal or casual, imperative or polite.",
  "style.format": "How they format messages: lists, code blocks, paths, questions.",
  "work.stack": "Languages, frameworks and tools they work with.",
  "work.taskMix": "What kinds of tasks they ask for (features, fixes, reviews, research).",
  "work.granularity": "Whether they give small steps or whole goals at once.",
  "work.verification": "How they want work checked: tests, typecheck, screenshots, manual.",
  "flow.followups": "What they typically send after an agent finished a turn.",
  "prefs.agent": "What they expect from the agent: autonomy, questions, explanations.",
  "notes.1": "Any other stable habit worth remembering.",
  "notes.2": "Any other stable habit worth remembering.",
  "notes.3": "Any other stable habit worth remembering.",
  "notes.4": "Any other stable habit worth remembering.",
  "notes.5": "Any other stable habit worth remembering.",
};

export const DistillOutput = Schema.Struct({
  ops: Schema.Array(
    Schema.Struct({
      traitId: Schema.String,
      op: Schema.Literals(["add", "support", "contradict", "revise", "noop"]),
      /** The new value for `add` and `revise`, null otherwise. */
      value: Schema.NullOr(Schema.String),
      /** How many of the excerpts back this operation. */
      count: Schema.Number,
      /** Excerpt numbers, as shown. */
      evidence: Schema.Array(Schema.Number),
    }),
  ),
});
export type DistillOutput = typeof DistillOutput.Type;

const DISTILL_INSTRUCTIONS = `You maintain a small, factual profile of how one developer writes and works with coding agents. Never store secrets, health, finances, or details about other people. Only use the listed trait ids. Propose operations; do not rewrite the profile.

Operations, at most one per trait id:
- add: a trait id that has no value yet, with a short value (max 160 characters).
- support / contradict: the excerpts confirm or contradict the current value.
- revise: the excerpts show a different value; give the new value.
- noop: nothing to say.
"count" is how many excerpts back the operation, "evidence" lists their numbers. Values describe habits, in English, without quoting private content.`;

function featureLine(record: EvidenceRecord): string {
  const flags = [
    record.hasCode ? "code" : null,
    record.hasPath ? "path" : null,
    record.endsWithQuestion ? "question" : null,
  ].filter((flag) => flag !== null);
  return `${record.words} words, ${record.lang}${flags.length > 0 ? `, ${flags.join(", ")}` : ""}`;
}

/**
 * Picks the excerpts a distill shows: newest first, up to 30, within the
 * char budget. Records without an excerpt (pasted content) still show their
 * features. Returns them in the order they are numbered in the prompt.
 */
export function selectDistillEvidence(
  pending: ReadonlyArray<EvidenceRecord>,
): ReadonlyArray<EvidenceRecord> {
  const selected: Array<EvidenceRecord> = [];
  let budget = DISTILL_EXCERPT_CHAR_BUDGET;
  for (const record of pending.toReversed()) {
    if (selected.length >= DISTILL_MAX_EXCERPTS) break;
    const cost = (record.excerpt?.length ?? 0) + 60;
    if (cost > budget) break;
    budget -= cost;
    selected.push(record);
  }
  return selected;
}

/** The distill prompt; excerpt `n` in it is `evidence[n - 1]`. */
export function buildDistillPrompt(input: {
  readonly profile: UserInsightsProfile;
  readonly evidence: ReadonlyArray<EvidenceRecord>;
}): string {
  const taxonomy = Object.entries(TRAIT_DEFINITIONS)
    .map(([id, definition]) => `- ${id}: ${definition}`)
    .join("\n");
  const traits =
    input.profile.traits.length === 0
      ? "(none yet)"
      : input.profile.traits
          .map(
            (trait) =>
              `- ${trait.id} = ${JSON.stringify(trait.value)} (confidence ${trait.confidence.toFixed(2)}${trait.pinned ? ", set by the user" : ""})`,
          )
          .join("\n");
  const excerpts = input.evidence
    .map(
      (record, index) =>
        `${index + 1}. [${featureLine(record)}] ${record.excerpt === undefined ? "(pasted content, not shown)" : JSON.stringify(record.excerpt)}`,
    )
    .join("\n");
  return `${DISTILL_INSTRUCTIONS}

Trait ids:
${taxonomy}

Current profile:
${traits}

New messages from the developer, newest first:
${excerpts}`;
}
