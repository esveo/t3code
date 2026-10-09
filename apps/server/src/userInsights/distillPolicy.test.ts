import { describe, expect, it } from "@effect/vitest";

import {
  DAILY_COST_CAP_USD,
  distillDecision,
  emptyState,
  MAX_DISTILLS_PER_DAY,
  recordCall,
  recordFailure,
  recordSuccess,
  rollDay,
  type UserInsightsState,
} from "./distillPolicy.ts";
import { DAY_MS, toIso } from "./time.ts";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const MINUTE = 60_000;
const enabled = { enabled: true };

const state = (overrides: Partial<UserInsightsState>): UserInsightsState => ({
  ...emptyState(NOW),
  ...overrides,
});

describe("distillDecision", () => {
  it("distills a full batch once the user paused for two minutes", () => {
    const waiting = state({
      pendingEvidence: 10,
      lastMessageAt: toIso(NOW - MINUTE),
      lastDistillAt: toIso(NOW),
    });
    expect(distillDecision(waiting, enabled, NOW)).toEqual({ kind: "skip", reason: "waiting" });
    expect(distillDecision(waiting, enabled, NOW + MINUTE)).toEqual({ kind: "distill" });
  });

  it("distills a full batch after 15 minutes even when the user never pauses", () => {
    const busy = state({
      pendingEvidence: 12,
      firstPendingAt: toIso(NOW - 14 * MINUTE),
      lastMessageAt: toIso(NOW - 30_000),
    });
    expect(distillDecision(busy, enabled, NOW)).toEqual({ kind: "skip", reason: "waiting" });
    expect(
      distillDecision({ ...busy, lastMessageAt: toIso(NOW + 30_000) }, enabled, NOW + MINUTE),
    ).toEqual({ kind: "distill" });
  });

  it("distills a small batch once its oldest message waited an hour", () => {
    const small = state({
      pendingEvidence: 3,
      firstPendingAt: toIso(NOW - 59 * MINUTE),
      lastMessageAt: toIso(NOW),
      lastDistillAt: toIso(NOW - 2 * DAY_MS),
    });
    expect(distillDecision(small, enabled, NOW).kind).toBe("skip");
    expect(distillDecision(small, enabled, NOW + MINUTE)).toEqual({ kind: "distill" });
    expect(distillDecision({ ...small, pendingEvidence: 2 }, enabled, NOW + MINUTE)).toEqual({
      kind: "skip",
      reason: "not-enough",
    });
  });

  it("stops when disabled, backing off, over budget or at the daily limit", () => {
    const ready = state({ pendingEvidence: 20, lastMessageAt: toIso(NOW - 10 * MINUTE) });
    expect(distillDecision(ready, enabled, NOW)).toEqual({ kind: "distill" });
    expect(distillDecision(ready, { enabled: false }, NOW).kind).toBe("skip");
    expect(distillDecision(recordFailure(ready, NOW), enabled, NOW)).toEqual({
      kind: "skip",
      reason: "backoff",
    });
    expect(distillDecision({ ...ready, costTodayUsd: DAILY_COST_CAP_USD }, enabled, NOW)).toEqual({
      kind: "skip",
      reason: "budget",
    });
    expect(
      distillDecision({ ...ready, distillsToday: MAX_DISTILLS_PER_DAY }, enabled, NOW),
    ).toEqual({ kind: "skip", reason: "daily-limit" });
  });
});

describe("counters", () => {
  it("backs off 15 minutes, then an hour, and clears on success", () => {
    const once = recordFailure(emptyState(NOW), NOW);
    expect(once.backoffUntil).toBe(toIso(NOW + 15 * MINUTE));
    const twice = recordFailure(once, NOW);
    expect(twice.backoffUntil).toBe(toIso(NOW + 60 * MINUTE));
    const recovered = recordSuccess({ ...twice, pendingEvidence: 12 }, 10, NOW);
    expect(recovered).toMatchObject({ failures: 0, backoffUntil: null, pendingEvidence: 2 });
    // The two messages that arrived during the call wait from now on.
    expect(recovered.firstPendingAt).toBe(toIso(NOW));
    expect(recordSuccess({ ...twice, pendingEvidence: 10 }, 10, NOW).firstPendingAt).toBeNull();
  });

  it("counts calls and resets them on a new day", () => {
    const counted = recordCall(recordCall(emptyState(NOW), { purpose: "distill", costUsd: 0.02 }), {
      purpose: "suggest",
      costUsd: 0.01,
    });
    expect(counted).toMatchObject({ distillsToday: 1, suggestsToday: 1 });
    expect(counted.costTodayUsd).toBeCloseTo(0.03);
    expect(rollDay(counted, NOW + MINUTE)).toBe(counted);
    expect(rollDay(counted, NOW + DAY_MS)).toMatchObject({
      day: "2026-10-09",
      distillsToday: 0,
      suggestsToday: 0,
      costTodayUsd: 0,
    });
  });
});
