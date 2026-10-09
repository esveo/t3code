import type { UserInsightsProfile, UserInsightsTrait } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyOps,
  confidenceLevel,
  confidenceOf,
  decay,
  type DistillOp,
  editTrait,
  emptyProfile,
  isProfileReady,
  validateOps,
} from "./profileMerge.ts";
import { DAY_MS, toIso } from "./time.ts";

const NOW = 1_790_000_000_000;

const trait = (overrides: Partial<UserInsightsTrait> & Pick<UserInsightsTrait, "id">) =>
  ({
    value: "value",
    support: 5,
    contradict: 0,
    confidence: confidenceOf(overrides.support ?? 5, overrides.contradict ?? 0),
    lastSeen: toIso(NOW),
    pinned: false,
    examples: [],
    ...overrides,
  }) satisfies UserInsightsTrait;

const profileWith = (traits: ReadonlyArray<UserInsightsTrait>, sampleCount = 0) =>
  ({ ...emptyProfile(NOW), sampleCount, traits }) satisfies UserInsightsProfile;

const op = (overrides: Partial<DistillOp> & Pick<DistillOp, "traitId" | "op">): DistillOp => ({
  value: null,
  count: 1,
  evidence: [1],
  ...overrides,
});

describe("confidence", () => {
  it("halves counts every 30 days", () => {
    expect(decay(8, 30 * DAY_MS)).toBeCloseTo(4);
    expect(decay(8, 60 * DAY_MS)).toBeCloseTo(2);
    expect(decay(8, 0)).toBe(8);
  });

  it("grows with support and shrinks with contradiction", () => {
    const values = [0, 1, 3, 10, 30].map((support) => confidenceOf(support, 0));
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThan(values[index - 1]!);
    }
    expect(confidenceOf(10, 5)).toBeLessThan(confidenceOf(10, 0));
    expect(confidenceOf(0, 0)).toBeLessThan(0.5);
  });

  it("maps to low, medium and high", () => {
    expect(confidenceLevel(0.49)).toBe("low");
    expect(confidenceLevel(0.5)).toBe("medium");
    expect(confidenceLevel(0.75)).toBe("high");
  });
});

describe("validateOps", () => {
  const profile = profileWith([trait({ id: "style.tone", pinned: true })]);

  it("rejects unknown ids, long values, bad evidence, missing traits and pinned revisions", () => {
    const { accepted, rejected } = validateOps(
      [
        op({ traitId: "style.mood", op: "add", value: "happy" }),
        op({ traitId: "style.length", op: "add", value: "x".repeat(161) }),
        op({ traitId: "work.stack", op: "add", value: "TypeScript", evidence: [4] }),
        op({ traitId: "work.taskMix", op: "support" }),
        op({ traitId: "style.tone", op: "revise", value: "formal" }),
        op({ traitId: "style.format", op: "add", value: "Lists" }),
      ],
      { profile, excerptCount: 3 },
    );
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "unknown trait id",
      "value too long",
      "evidence index out of range",
      "trait does not exist",
      "trait is pinned",
    ]);
    expect(accepted.map((entry) => entry.traitId)).toEqual(["style.format"]);
  });

  it("accepts support and contradiction of a pinned trait", () => {
    const { accepted } = validateOps([op({ traitId: "style.tone", op: "contradict" })], {
      profile,
      excerptCount: 1,
    });
    expect(accepted).toHaveLength(1);
  });

  it("allows up to the fifth note", () => {
    const full = profileWith(
      ["notes.1", "notes.2", "notes.3", "notes.4"].map((id) => trait({ id: id as never })),
    );
    const { rejected } = validateOps([op({ traitId: "notes.5", op: "add", value: "x" })], {
      profile: full,
      excerptCount: 1,
    });
    expect(rejected).toHaveLength(0);
  });
});

describe("applyOps", () => {
  const input = { now: NOW, evidenceIds: ["m1", "m2", "m3"], newSamples: 3 };

  it("adds traits and counts the samples", () => {
    const next = applyOps(
      emptyProfile(NOW),
      [op({ traitId: "work.stack", op: "add", value: "TypeScript", count: 3, evidence: [1, 3] })],
      input,
    );
    expect(next.sampleCount).toBe(3);
    expect(next.traits[0]).toMatchObject({
      id: "work.stack",
      value: "TypeScript",
      support: 3,
      examples: ["m1", "m3"],
    });
    expect(next.traits[0]!.confidence).toBeCloseTo(confidenceOf(3, 0));
  });

  it("moves a trait by at most three observations per batch", () => {
    const next = applyOps(
      profileWith([]),
      [op({ traitId: "style.tone", op: "add", value: "Direct", count: 10, evidence: [1] })],
      input,
    );
    const tone = next.traits.find((t) => t.id === "style.tone");
    expect(tone?.support).toBe(3);
    expect(confidenceLevel(tone?.confidence ?? 0)).toBe("medium");
  });

  it("decays old counts before adding new support", () => {
    const old = profileWith([
      trait({ id: "work.stack", support: 8, lastSeen: toIso(NOW - 30 * DAY_MS) }),
    ]);
    const next = applyOps(old, [op({ traitId: "work.stack", op: "support", count: 2 })], input);
    expect(next.traits[0]!.support).toBeCloseTo(6);
  });

  it("revises a value only once contradiction outweighs support", () => {
    const start = profileWith([trait({ id: "style.length", value: "short", support: 5 })]);
    const once = applyOps(
      start,
      [op({ traitId: "style.length", op: "revise", value: "long", count: 3 })],
      input,
    );
    expect(once.traits[0]!.value).toBe("short");
    const twice = applyOps(
      once,
      [op({ traitId: "style.length", op: "revise", value: "long", count: 3 })],
      input,
    );
    expect(twice.traits[0]).toMatchObject({ value: "long", support: 6, contradict: 5 });
  });

  it("drops unpinned traits that stayed weak and unseen for 60 days", () => {
    const stale = toIso(NOW - 61 * DAY_MS);
    const next = applyOps(
      profileWith([
        trait({ id: "notes.1", support: 0, contradict: 3, confidence: 0.1, lastSeen: stale }),
        trait({ id: "notes.2", confidence: 0.1, lastSeen: stale, pinned: true }),
        trait({ id: "notes.3", confidence: 0.8, lastSeen: stale }),
      ]),
      [],
      input,
    );
    expect(next.traits.map((entry) => entry.id)).toEqual(["notes.2", "notes.3"]);
  });
});

describe("editTrait", () => {
  it("pins the edited value so a later revision cannot replace it", () => {
    const edited = editTrait(emptyProfile(NOW), "style.tone", "Direct", NOW);
    expect(edited.traits[0]).toMatchObject({ value: "Direct", pinned: true });
    const { rejected } = validateOps([op({ traitId: "style.tone", op: "revise", value: "x" })], {
      profile: edited,
      excerptCount: 1,
    });
    expect(rejected).toHaveLength(1);
  });
});

describe("isProfileReady", () => {
  const confident = (id: string) => trait({ id: id as never, confidence: 0.8 });

  it("needs 40 samples and four confident traits including flow.followups", () => {
    const traits = ["style.language", "style.tone", "work.stack", "flow.followups"].map(confident);
    expect(isProfileReady(profileWith(traits, 40))).toBe(true);
    expect(isProfileReady(profileWith(traits, 39))).toBe(false);
    expect(isProfileReady(profileWith(traits.slice(0, 3), 40))).toBe(false);
    const withoutFollowups = ["style.language", "style.tone", "work.stack", "style.format"].map(
      confident,
    );
    expect(isProfileReady(profileWith(withoutFollowups, 40))).toBe(false);
  });
});
