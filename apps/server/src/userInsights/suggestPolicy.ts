/**
 * Fork: user insights. When the server may spend a Haiku call on next-message
 * suggestions, and what the user's reaction to a shown set means. Pure, over
 * `state.json` and `feedback.jsonl`.
 *
 * The feedback loop: a set the user neither fills nor sends counts as
 * ignored, a dismissal as dismissed. Two misses in a row cool a thread down
 * for 30 minutes. Low acceptance over the last 30 sets throttles suggestions
 * to every third turn, very low acceptance pauses them until the user turns
 * suggestions off and on again.
 */
import type { UserInsightsSuggestSkip } from "@t3tools/contracts";

import { isOverBudget, MAX_SUGGESTS_PER_DAY, type UserInsightsState } from "./distillPolicy.ts";
import type { FeedbackRecord } from "./store.ts";
import { DAY_MS, fromIso, toIso } from "./time.ts";

export const SUGGEST_COOLDOWN_MS = 30 * 60 * 1000;
/** Misses in a row (dismissed or ignored) that cool a thread down. */
export const SUGGEST_MISSES_FOR_COOLDOWN = 2;
/** "Not for this thread" lasts this long. */
export const SUGGEST_MUTE_MS = 90 * DAY_MS;
export const ACCEPTANCE_WINDOW = 30;
/** Fewer shown sets than this are too few to judge acceptance by. */
export const ACCEPTANCE_MIN_SETS = 10;
export const THROTTLE_BELOW = 0.15;
export const PAUSE_BELOW = 0.05;
export const THROTTLE_EVERY = 3;

export type FeedbackOutcome = FeedbackRecord["outcome"];
export type AcceptanceLevel = "normal" | "throttled" | "paused";

/** The last 30 sets with an outcome since the last acceptance reset. */
export function recentFeedback(
  feedback: ReadonlyArray<FeedbackRecord>,
  resetAt: string | null | undefined,
): ReadonlyArray<FeedbackRecord> {
  const since = resetAt ? fromIso(resetAt) : Number.NEGATIVE_INFINITY;
  return feedback.filter((record) => fromIso(record.ts) > since).slice(-ACCEPTANCE_WINDOW);
}

/**
 * Below 15% accepted or edited throttles, below 5% over a full window of 30
 * sets pauses. Too few sets never throttle.
 */
export function acceptanceLevel(
  feedback: ReadonlyArray<FeedbackRecord>,
  resetAt: string | null | undefined,
): AcceptanceLevel {
  const recent = recentFeedback(feedback, resetAt);
  if (recent.length < ACCEPTANCE_MIN_SETS) return "normal";
  const taken = recent.filter(
    (record) => record.outcome === "accepted" || record.outcome === "edited",
  ).length;
  const rate = taken / recent.length;
  if (recent.length >= ACCEPTANCE_WINDOW && rate < PAUSE_BELOW) return "paused";
  if (rate < THROTTLE_BELOW) return "throttled";
  return "normal";
}

const activeUntil = (map: Readonly<Record<string, string>>, threadId: string, now: number) => {
  const until = map[threadId];
  return until !== undefined && fromIso(until) > now;
};

/**
 * Whether a new suggestion set may be asked for in this thread, before any
 * per-turn counting. `ready` and `paused` come from the profile and the
 * background status; `state` must already be rolled to `now`.
 */
export function suggestGate(input: {
  readonly state: UserInsightsState;
  readonly threadId: string;
  readonly ready: boolean;
  readonly paused: boolean;
  readonly acceptance: AcceptanceLevel;
  readonly now: number;
}): UserInsightsSuggestSkip | null {
  const { state, threadId, now } = input;
  if (input.paused || isOverBudget(state) || input.acceptance === "paused") return "paused";
  if (!input.ready) return "not-ready";
  if (state.suggestsToday >= MAX_SUGGESTS_PER_DAY) return "daily-limit";
  if (activeUntil(state.mutedThreads, threadId, now)) return "muted";
  if (activeUntil(state.threadCooldowns, threadId, now)) return "cooldown";
  return null;
}

/**
 * Counts one eligible turn; while throttled only every third one gets a set.
 * Returns the new state and whether this turn may call the model.
 */
export function countEligibleTurn(
  state: UserInsightsState,
  acceptance: AcceptanceLevel,
): { readonly state: UserInsightsState; readonly allowed: boolean } {
  const count = state.eligibleSuggests ?? 0;
  const allowed = acceptance !== "throttled" || count % THROTTLE_EVERY === 0;
  return { state: { ...state, eligibleSuggests: count + 1 }, allowed };
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * What the user's next message in the thread says about the open set: the
 * filled prompt sent as is was accepted, a filled but changed one edited,
 * anything else ignored.
 */
export function classifyOutcome(
  filledPrompt: string | null,
  sentText: string,
): "accepted" | "edited" | "ignored" {
  if (filledPrompt === null) return "ignored";
  return normalize(filledPrompt) === normalize(sentText) ? "accepted" : "edited";
}

/**
 * Updates the thread's miss streak: a taken set clears it, two misses in a
 * row start a 30-minute cooldown in that thread.
 */
export function recordOutcome(
  state: UserInsightsState,
  threadId: string,
  outcome: FeedbackOutcome,
  now: number,
): UserInsightsState {
  const { [threadId]: _misses, ...otherMisses } = state.consecutiveMisses;
  if (outcome === "accepted" || outcome === "edited") {
    return { ...state, consecutiveMisses: otherMisses };
  }
  const misses = (state.consecutiveMisses[threadId] ?? 0) + 1;
  if (misses < SUGGEST_MISSES_FOR_COOLDOWN) {
    return { ...state, consecutiveMisses: { ...otherMisses, [threadId]: misses } };
  }
  return {
    ...state,
    consecutiveMisses: otherMisses,
    threadCooldowns: {
      ...pruneExpired(state.threadCooldowns, now),
      [threadId]: toIso(now + SUGGEST_COOLDOWN_MS),
    },
  };
}

export function muteThread(
  state: UserInsightsState,
  threadId: string,
  now: number,
): UserInsightsState {
  return {
    ...state,
    mutedThreads: {
      ...pruneExpired(state.mutedThreads, now),
      [threadId]: toIso(now + SUGGEST_MUTE_MS),
    },
  };
}

function pruneExpired(map: Readonly<Record<string, string>>, now: number) {
  return Object.fromEntries(Object.entries(map).filter(([, until]) => fromIso(until) > now));
}
