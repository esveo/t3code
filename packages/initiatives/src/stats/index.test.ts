import { describe, expect, it } from "vite-plus/test";

import { attributeQuota, estimateFrom, middleRange, type StatsSample } from "./index.ts";

const sample = (provider: string, model: string, apiUsd: number): StatsSample => ({
  provider,
  model,
  apiUsd,
  tokens: apiUsd * 1000,
  durationMs: apiUsd * 60_000,
  turns: 3,
});

describe("estimateFrom", () => {
  it("takes the middle half of similar sessions, the same model first", () => {
    const samples = [1, 2, 3, 4, 5].map((usd) => sample("claudeAgent", "opus", usd));
    const estimate = estimateFrom({ provider: "claudeAgent", model: "opus" }, samples);
    expect(estimate).toMatchObject({ basis: 5, match: "same-model", apiUsd: [2, 4] });
  });

  it("falls back to the provider and gives nothing below three sessions", () => {
    const samples = [
      sample("codex", "gpt-6", 1),
      sample("codex", "gpt-5", 2),
      sample("codex", "gpt-5", 3),
    ];
    expect(estimateFrom({ provider: "codex", model: "gpt-6" }, samples)?.match).toBe(
      "same-provider",
    );
    expect(estimateFrom({ provider: "grok", model: null }, samples)).toBeNull();
  });

  it("interpolates quartiles", () => {
    expect(middleRange([1, 2])).toEqual([1.25, 1.75]);
    expect(middleRange([])).toBeNull();
  });
});

describe("attributeQuota", () => {
  const hour = 3_600_000;
  const at = (hours: number, usedPercent: number, resetsAt = "2026-10-01T00:00:00.000Z") => ({
    checkedAtMs: hours * hour,
    usedPercent,
    resetsAt,
  });

  it("splits each rise among the sessions active then, by tokens", () => {
    const result = attributeQuota(
      [at(0, 10), at(1, 20), at(2, 26)],
      [
        { key: "a", startMs: 0, endMs: 2 * hour, tokens: 2000 },
        { key: "b", startMs: 1 * hour, endMs: 2 * hour, tokens: 1000 },
      ],
    );
    // 0–1 h: only a, +10. 1–2 h: a (1000 of its tokens) and b (1000), +6 split evenly.
    expect(result.bySession.get("a")).toBeCloseTo(13);
    expect(result.bySession.get("b")).toBeCloseTo(3);
    expect(result.observed).toBe(16);
    // The 10 % before the first observation nobody saw.
    expect(result.unattributed).toBe(10);
  });

  it("starts over after a reset and never counts it as negative use", () => {
    const result = attributeQuota(
      [
        at(0, 80),
        at(1, 90),
        at(2, 5, "2026-10-08T00:00:00.000Z"),
        at(3, 8, "2026-10-08T00:00:00.000Z"),
      ],
      [{ key: "a", startMs: 2 * hour, endMs: 3 * hour, tokens: 100 }],
    );
    expect(result.bySession.get("a")).toBeCloseTo(3);
    expect(result.observed).toBe(3);
    expect(result.unattributed).toBe(5);
  });

  it("leaves a rise without an active session unattributed", () => {
    const result = attributeQuota([at(0, 0), at(1, 7)], []);
    expect(result).toMatchObject({ unattributed: 7, gaps: 1 });
  });
});
