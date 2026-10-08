import { describe, expect, it } from "@effect/vitest";

import { emptyState, MAX_SUGGESTS_PER_DAY } from "./distillPolicy.ts";
import type { FeedbackRecord } from "./store.ts";
import {
  acceptanceLevel,
  classifyOutcome,
  countEligibleTurn,
  muteThread,
  recordOutcome,
  SUGGEST_COOLDOWN_MS,
  suggestGate,
} from "./suggestPolicy.ts";
import { toIso } from "./time.ts";

const NOW = Date.UTC(2026, 9, 8, 12);

const feedback = (outcomes: ReadonlyArray<FeedbackRecord["outcome"]>, start = NOW - 60_000) =>
  outcomes.map((outcome, index): FeedbackRecord => ({
    ts: toIso(start + index),
    threadId: "thread-1",
    setId: `set-${index}`,
    labels: ["Run the tests"],
    outcome,
  }));

const gate = (overrides: Partial<Parameters<typeof suggestGate>[0]> = {}) =>
  suggestGate({
    state: emptyState(NOW),
    threadId: "thread-1",
    ready: true,
    paused: false,
    acceptance: "normal",
    now: NOW,
    ...overrides,
  });

describe("suggestGate", () => {
  it("lets a ready, quiet thread through", () => {
    expect(gate()).toBeNull();
  });

  it("refuses before the profile is ready, while paused, and over the daily limit", () => {
    expect(gate({ ready: false })).toBe("not-ready");
    expect(gate({ paused: true })).toBe("paused");
    expect(gate({ acceptance: "paused" })).toBe("paused");
    expect(gate({ state: { ...emptyState(NOW), costTodayUsd: 1 } })).toBe("paused");
    expect(gate({ state: { ...emptyState(NOW), suggestsToday: MAX_SUGGESTS_PER_DAY } })).toBe(
      "daily-limit",
    );
  });

  it("respects a mute until it runs out", () => {
    const muted = muteThread(emptyState(NOW), "thread-1", NOW);
    expect(gate({ state: muted })).toBe("muted");
    expect(gate({ state: muted, threadId: "thread-2" })).toBeNull();
    expect(gate({ state: muted, now: NOW + 91 * 24 * 60 * 60 * 1000 })).toBeNull();
  });
});

describe("recordOutcome", () => {
  it("cools a thread down after two misses in a row, for 30 minutes", () => {
    const once = recordOutcome(emptyState(NOW), "thread-1", "dismissed", NOW);
    expect(once.consecutiveMisses).toEqual({ "thread-1": 1 });
    expect(gate({ state: once })).toBeNull();
    const twice = recordOutcome(once, "thread-1", "ignored", NOW);
    expect(twice.consecutiveMisses).toEqual({});
    expect(gate({ state: twice })).toBe("cooldown");
    expect(gate({ state: twice, now: NOW + SUGGEST_COOLDOWN_MS + 1 })).toBeNull();
  });

  it("clears the streak when a set is taken", () => {
    const missed = recordOutcome(emptyState(NOW), "thread-1", "ignored", NOW);
    const taken = recordOutcome(missed, "thread-1", "edited", NOW);
    const missedAgain = recordOutcome(taken, "thread-1", "ignored", NOW);
    expect(gate({ state: missedAgain })).toBeNull();
  });
});

describe("acceptanceLevel", () => {
  it("does not judge fewer than ten sets", () => {
    expect(acceptanceLevel(feedback(Array(9).fill("ignored")), null)).toBe("normal");
  });

  it("throttles below 15% and pauses below 5% over a full window", () => {
    const low = feedback([...Array(9).fill("ignored"), "accepted", ...Array(10).fill("dismissed")]);
    expect(acceptanceLevel(low, null)).toBe("throttled");
    expect(acceptanceLevel(feedback(Array(30).fill("ignored")), null)).toBe("paused");
    const fine = feedback([...Array(8).fill("ignored"), "accepted", "edited"]);
    expect(acceptanceLevel(fine, null)).toBe("normal");
  });

  it("only counts sets after the last reset", () => {
    const old = feedback(Array(30).fill("ignored"));
    expect(acceptanceLevel(old, toIso(NOW))).toBe("normal");
  });
});

describe("countEligibleTurn", () => {
  it("allows every turn normally and every third one while throttled", () => {
    let state = emptyState(NOW);
    const allowed: Array<boolean> = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const counted = countEligibleTurn(state, "throttled");
      state = counted.state;
      allowed.push(counted.allowed);
    }
    expect(allowed).toEqual([true, false, false, true, false, false]);
    expect(countEligibleTurn(state, "normal").allowed).toBe(true);
  });
});

describe("classifyOutcome", () => {
  it("tells accepted, edited and ignored apart", () => {
    expect(classifyOutcome("Run the tests", "  Run the  tests\n")).toBe("accepted");
    expect(classifyOutcome("Run the tests", "Run the tests and lint")).toBe("edited");
    expect(classifyOutcome(null, "Something else")).toBe("ignored");
  });
});
