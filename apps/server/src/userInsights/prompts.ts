/**
 * Fork: user insights. The texts and output schemas of the Haiku calls. Kept
 * short and stable: the CLI's own system prompt already dominates the cost.
 */
import {
  USER_INSIGHTS_MAX_SUGGESTIONS,
  USER_INSIGHTS_SUGGESTION_DESCRIPTION_MAX,
  USER_INSIGHTS_SUGGESTION_LABEL_MAX,
  type UserInsightsProfile,
  type UserInsightsSuggestion,
  type UserInsightsTraitId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { EvidenceRecord } from "./evidence.ts";
import { redact } from "./redaction.ts";
import type { FeedbackRecord } from "./store.ts";

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

/** Most suggestion reactions one distill shows. */
export const DISTILL_MAX_FEEDBACK = 10;

/**
 * How the user reacted to suggestions since the last distill, as lines for
 * `flow.followups`: what they took supports it, what they dismissed
 * contradicts it. Ignored sets say too little to show.
 */
export function feedbackLines(feedback: ReadonlyArray<FeedbackRecord>): ReadonlyArray<string> {
  const lines: Array<string> = [];
  for (const record of feedback) {
    if (record.outcome === "ignored") continue;
    const labels =
      record.index !== undefined && record.outcome !== "dismissed"
        ? [record.labels[record.index] ?? ""]
        : record.labels;
    const shown = labels.filter((label) => label.length > 0).map((label) => JSON.stringify(label));
    if (shown.length > 0) lines.push(`- ${record.outcome}: ${shown.join(", ")}`);
  }
  return lines.slice(-DISTILL_MAX_FEEDBACK);
}

/** The distill prompt; excerpt `n` in it is `evidence[n - 1]`. */
export function buildDistillPrompt(input: {
  readonly profile: UserInsightsProfile;
  readonly evidence: ReadonlyArray<EvidenceRecord>;
  /** Reactions to suggestions since the last distill. */
  readonly feedback?: ReadonlyArray<FeedbackRecord>;
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
  const reactions = feedbackLines(input.feedback ?? []);
  const feedbackSection =
    reactions.length === 0
      ? ""
      : `

How they reacted to suggested next messages (accepted or edited ones support flow.followups, dismissed ones contradict it; these are not excerpts and have no number):
${reactions.join("\n")}`;
  return `${DISTILL_INSTRUCTIONS}

Trait ids:
${taxonomy}

Current profile:
${traits}

New messages from the developer, newest first:
${excerpts}${feedbackSection}`;
}

export const SuggestOutput = Schema.Struct({
  suggestions: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      prompt: Schema.String,
    }),
  ),
});
export type SuggestOutput = typeof SuggestOutput.Type;

/** How much of each side of the last exchange a suggest call shows. */
export const SUGGEST_EXCHANGE_MAX_CHARS = 1500;
/** Traits below this confidence stay out of the suggest prompt. */
export const SUGGEST_MIN_CONFIDENCE = 0.5;
export const SUGGEST_PROMPT_MAX_CHARS = 2000;

const SUGGEST_INSTRUCTIONS = `Suggest at most 3 next messages this user would plausibly send now, written in their style and language. Prefer concrete next steps (verify, commit, follow-up fix) over generic ones. Return an empty list if nothing is clearly useful.

Each suggestion has a short label (max 60 characters), a one-sentence description of what it does (max 140 characters), and the full prompt the user would send.`;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The suggest prompt for one finished turn. */
export function buildSuggestPrompt(input: {
  readonly profile: UserInsightsProfile;
  readonly threadTitle: string;
  readonly userText: string | null;
  readonly assistantText: string | null;
  readonly feedback: ReadonlyArray<FeedbackRecord>;
}): string {
  const traits = input.profile.traits
    .filter((trait) => trait.confidence >= SUGGEST_MIN_CONFIDENCE)
    .map((trait) => `- ${trait.id}: ${trait.value}`)
    .join("\n");
  const reactions = input.feedback
    .slice(-10)
    .map(
      (record) => `- ${record.outcome}: ${record.labels.map((l) => JSON.stringify(l)).join(", ")}`,
    )
    .join("\n");
  const exchange = (text: string | null) =>
    text === null ? "(none)" : redact(clip(text.trim(), SUGGEST_EXCHANGE_MAX_CHARS));
  return `${SUGGEST_INSTRUCTIONS}

How this user writes and works:
${traits.length > 0 ? traits : "(nothing confident yet)"}

How they reacted to earlier suggestions:
${reactions.length > 0 ? reactions : "(none yet)"}

Thread: ${JSON.stringify(input.threadTitle)}

Their last message:
${exchange(input.userText)}

The agent's reply:
${exchange(input.assistantText)}`;
}

/** At most three suggestions with a label and a prompt, label and description clipped. */
export function sanitizeSuggestions(output: SuggestOutput): ReadonlyArray<UserInsightsSuggestion> {
  return output.suggestions
    .map((suggestion) => ({
      label: clip(suggestion.label.trim(), USER_INSIGHTS_SUGGESTION_LABEL_MAX),
      description: clip(suggestion.description.trim(), USER_INSIGHTS_SUGGESTION_DESCRIPTION_MAX),
      prompt: suggestion.prompt.trim().slice(0, SUGGEST_PROMPT_MAX_CHARS),
    }))
    .filter((suggestion) => suggestion.label.length > 0 && suggestion.prompt.length > 0)
    .slice(0, USER_INSIGHTS_MAX_SUGGESTIONS);
}
