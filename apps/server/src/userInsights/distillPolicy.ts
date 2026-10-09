/**
 * Fork: user insights. When a distill runs, and what the daily caps and the
 * failure backoff allow. Pure, over the `state.json` record, so a restart
 * simply picks up where the last tick left off.
 */
import { USER_INSIGHTS_DAILY_COST_CAP_USD, type UserInsightsPauseReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { fromIso, toIso } from "./time.ts";

export const DAILY_COST_CAP_USD = USER_INSIGHTS_DAILY_COST_CAP_USD;
export const MAX_DISTILLS_PER_DAY = 12;
export const MAX_SUGGESTS_PER_DAY = 60;
/** Pending messages that trigger a distill once the user paused for a moment. */
export const DISTILL_BATCH = 10;
export const DISTILL_IDLE_MS = 2 * 60 * 1000;
/** A full batch also runs once its oldest message waited this long, pause or not. */
export const DISTILL_BATCH_MAX_WAIT_MS = 15 * 60 * 1000;
/** Fewer pending messages still get distilled once the oldest waited an hour. */
export const DISTILL_MIN_BATCH = 3;
export const DISTILL_STALE_MS = 60 * 60 * 1000;
export const BACKOFF_FIRST_MS = 15 * 60 * 1000;
export const BACKOFF_REPEAT_MS = 60 * 60 * 1000;

/**
 * An import of past messages: the queued records sit in `import.jsonl`,
 * `done` of them are learned from. Kept here so it resumes after a restart.
 */
export const ImportCursor = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["running", "done", "cancelled"]),
  done: Schema.Number,
  total: Schema.Number,
  startedAt: Schema.String,
});
export type ImportCursor = typeof ImportCursor.Type;

export const UserInsightsState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** Observed messages not yet distilled. */
  pendingEvidence: Schema.Number,
  lastMessageAt: Schema.NullOr(Schema.String),
  /** When the oldest pending message arrived; missing in older state files. */
  firstPendingAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastDistillAt: Schema.NullOr(Schema.String),
  backoffUntil: Schema.NullOr(Schema.String),
  /** Consecutive failed distills. */
  failures: Schema.Number,
  /** The UTC day the counters below belong to, `YYYY-MM-DD`. */
  day: Schema.String,
  distillsToday: Schema.Number,
  suggestsToday: Schema.Number,
  costTodayUsd: Schema.Number,
  mutedThreads: Schema.Record(Schema.String, Schema.String),
  threadCooldowns: Schema.Record(Schema.String, Schema.String),
  consecutiveMisses: Schema.Record(Schema.String, Schema.Number),
  /** Acceptance counts only feedback after this; set when suggestions are turned back on. */
  acceptanceResetAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Turns that passed every suggestion gate, for "every third turn" throttling. */
  eligibleSuggests: Schema.optionalKey(Schema.Number),
  /** The last import of past messages. */
  import: Schema.optionalKey(Schema.NullOr(ImportCursor)),
});
export type UserInsightsState = typeof UserInsightsState.Type;

export const utcDay = (now: number) => toIso(now).slice(0, 10);

export const emptyState = (now: number): UserInsightsState => ({
  schemaVersion: 1,
  pendingEvidence: 0,
  lastMessageAt: null,
  lastDistillAt: null,
  backoffUntil: null,
  failures: 0,
  day: utcDay(now),
  distillsToday: 0,
  suggestsToday: 0,
  costTodayUsd: 0,
  mutedThreads: {},
  threadCooldowns: {},
  consecutiveMisses: {},
});

/** Resets the daily counters once the day changed. */
export function rollDay(state: UserInsightsState, now: number): UserInsightsState {
  const day = utcDay(now);
  if (state.day === day) return state;
  return { ...state, day, distillsToday: 0, suggestsToday: 0, costTodayUsd: 0 };
}

const since = (iso: string | null, now: number) =>
  iso === null ? Number.POSITIVE_INFINITY : now - fromIso(iso);

export const isBackingOff = (state: UserInsightsState, now: number) =>
  state.backoffUntil !== null && fromIso(state.backoffUntil) > now;

export const isOverBudget = (state: UserInsightsState) => state.costTodayUsd >= DAILY_COST_CAP_USD;

export type DistillDecision =
  | { readonly kind: "distill" }
  | {
      readonly kind: "skip";
      readonly reason: "disabled" | "backoff" | "budget" | "daily-limit" | "not-enough" | "waiting";
    };

/**
 * Distill when enabled, not backing off, under the daily caps, and either a
 * full batch waits and the user paused for two minutes or its oldest message
 * waited 15 minutes, or a small batch's oldest message waited an hour. Someone
 * who writes in several threads at once rarely pauses for two minutes, so the
 * wait counts from the oldest pending message, not the latest. `state` must
 * already be rolled to `now`.
 */
export function distillDecision(
  state: UserInsightsState,
  settings: { readonly enabled: boolean },
  now: number,
): DistillDecision {
  if (!settings.enabled) return { kind: "skip", reason: "disabled" };
  if (isBackingOff(state, now)) return { kind: "skip", reason: "backoff" };
  if (isOverBudget(state)) return { kind: "skip", reason: "budget" };
  if (state.distillsToday >= MAX_DISTILLS_PER_DAY) return { kind: "skip", reason: "daily-limit" };
  if (state.pendingEvidence < DISTILL_MIN_BATCH) return { kind: "skip", reason: "not-enough" };
  const oldestWait = since(state.firstPendingAt ?? state.lastMessageAt, now);
  if (
    state.pendingEvidence >= DISTILL_BATCH &&
    (since(state.lastMessageAt, now) >= DISTILL_IDLE_MS || oldestWait >= DISTILL_BATCH_MAX_WAIT_MS)
  ) {
    return { kind: "distill" };
  }
  if (oldestWait >= DISTILL_STALE_MS) return { kind: "distill" };
  return { kind: "skip", reason: "waiting" };
}

/** Counts one model call against today's caps; an import batch counts its cost only. */
export function recordCall(
  state: UserInsightsState,
  call: { readonly purpose: "distill" | "suggest" | "import"; readonly costUsd: number },
): UserInsightsState {
  return {
    ...state,
    distillsToday: state.distillsToday + (call.purpose === "distill" ? 1 : 0),
    suggestsToday: state.suggestsToday + (call.purpose === "suggest" ? 1 : 0),
    costTodayUsd: state.costTodayUsd + Math.max(0, call.costUsd),
  };
}

/** After a failed distill: 15 minutes, then an hour for every further failure. */
export function recordFailure(state: UserInsightsState, now: number): UserInsightsState {
  const failures = state.failures + 1;
  const wait = failures === 1 ? BACKOFF_FIRST_MS : BACKOFF_REPEAT_MS;
  return {
    ...state,
    failures,
    backoffUntil: toIso(now + wait),
  };
}

/** After a successful distill of `consumed` pending messages. */
export function recordSuccess(
  state: UserInsightsState,
  consumed: number,
  now: number,
): UserInsightsState {
  const pendingEvidence = Math.max(0, state.pendingEvidence - consumed);
  return {
    ...state,
    pendingEvidence,
    // Messages that arrived during the call start a new wait.
    firstPendingAt: pendingEvidence > 0 ? toIso(now) : null,
    lastDistillAt: toIso(now),
    failures: 0,
    backoffUntil: null,
  };
}

/** Why background work is paused right now, if it is. */
export function pauseReason(
  state: UserInsightsState,
  input: { readonly claudeAvailable: boolean },
  now: number,
): UserInsightsPauseReason | null {
  if (!input.claudeAvailable) return "claude-unavailable";
  if (isOverBudget(state)) return "budget";
  if (isBackingOff(state, now)) return "backoff";
  return null;
}
