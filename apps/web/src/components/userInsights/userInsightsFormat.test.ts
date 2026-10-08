import { describe, expect, it } from "vite-plus/test";

import {
  confidenceLevel,
  formatCostUsd,
  formatTokens,
  formatUsageTotals,
  statusText,
} from "./userInsightsFormat";

describe("user insights format", () => {
  it("maps confidence to low, medium and high at the server's thresholds", () => {
    expect([0, 0.49, 0.5, 0.74, 0.75, 1].map(confidenceLevel)).toEqual([
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
    ]);
  });

  it("says how far learning is and why it paused", () => {
    expect(statusText({ state: "learning", samples: 12, requiredSamples: 40 })).toContain(
      "12 of 40",
    );
    expect(statusText({ state: "paused", reason: "claude-unavailable" })).toContain("Claude");
    expect(statusText({ state: "paused", reason: "budget" })).toContain("tomorrow");
  });

  it("keeps small costs visible instead of rounding them to zero", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.0042)).toBe("$0.004");
    expect(formatCostUsd(0.126)).toBe("$0.13");
  });

  it("shortens token counts", () => {
    expect([850, 1_234, 45_600, 2_500_000].map(formatTokens)).toEqual([
      "850",
      "1.2k",
      "46k",
      "2.5M",
    ]);
  });

  it("summarizes calls, tokens and cost", () => {
    expect(formatUsageTotals({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })).toBe(
      "No calls",
    );
    expect(
      formatUsageTotals({ calls: 3, inputTokens: 12_300, outputTokens: 900, costUsd: 0.021 }),
    ).toBe("3 calls, 12k in / 900 out tokens, $0.02");
  });
});
