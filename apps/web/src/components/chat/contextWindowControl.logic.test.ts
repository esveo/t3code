import { describe, expect, it } from "vite-plus/test";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import {
  contextWindowRows,
  formatContextWindowPercentage,
  hasContextWindowFill,
  resolveContextWindowLimitPercentage,
  resolveContextWindowTone,
} from "./contextWindowControl.logic";

function usage(input: {
  usedPercentage?: number | null;
  maxTokens?: number | null;
  compactsAutomatically?: boolean;
  autoCompactThreshold?: number | null;
}) {
  return {
    usedPercentage: input.usedPercentage ?? null,
    maxTokens: input.maxTokens ?? null,
    compactsAutomatically: input.compactsAutomatically ?? false,
    autoCompactThreshold: input.autoCompactThreshold ?? null,
  };
}

describe("resolveContextWindowLimitPercentage", () => {
  it("is the threshold's share of the window", () => {
    expect(
      resolveContextWindowLimitPercentage(
        usage({ maxTokens: 200_000, compactsAutomatically: true, autoCompactThreshold: 160_000 }),
      ),
    ).toBe(80);
  });

  it("is absent when the provider does not compact automatically", () => {
    expect(
      resolveContextWindowLimitPercentage(
        usage({ maxTokens: 200_000, compactsAutomatically: false, autoCompactThreshold: 160_000 }),
      ),
    ).toBeNull();
  });

  it("ignores a threshold at or past the window, which would mark the end of the bar", () => {
    expect(
      resolveContextWindowLimitPercentage(
        usage({ maxTokens: 200_000, compactsAutomatically: true, autoCompactThreshold: 200_000 }),
      ),
    ).toBeNull();
  });

  it("is absent without a window to measure against", () => {
    expect(
      resolveContextWindowLimitPercentage(
        usage({ maxTokens: null, compactsAutomatically: true, autoCompactThreshold: 160_000 }),
      ),
    ).toBeNull();
  });
});

describe("resolveContextWindowTone", () => {
  it("warns from 80% of the window and alarms at the end", () => {
    expect(resolveContextWindowTone(usage({ usedPercentage: 42, maxTokens: 200_000 }))).toBe(
      "normal",
    );
    expect(resolveContextWindowTone(usage({ usedPercentage: 82, maxTokens: 200_000 }))).toBe(
      "warning",
    );
    expect(resolveContextWindowTone(usage({ usedPercentage: 100, maxTokens: 200_000 }))).toBe(
      "critical",
    );
  });

  it("measures against the compaction threshold when there is one", () => {
    const compacting = {
      maxTokens: 200_000,
      compactsAutomatically: true,
      autoCompactThreshold: 100_000,
    };
    // 45% of the window is 90% of the way to compaction.
    expect(resolveContextWindowTone(usage({ usedPercentage: 45, ...compacting }))).toBe("warning");
    expect(resolveContextWindowTone(usage({ usedPercentage: 52, ...compacting }))).toBe("critical");
    expect(resolveContextWindowTone(usage({ usedPercentage: 30, ...compacting }))).toBe("normal");
  });

  it("stays calm when the provider reports no percentage", () => {
    expect(resolveContextWindowTone(usage({ usedPercentage: null }))).toBe("normal");
  });
});

describe("formatContextWindowPercentage", () => {
  it("keeps a digit below ten percent and rounds above it", () => {
    expect(formatContextWindowPercentage(3.42)).toBe("3.4%");
    expect(formatContextWindowPercentage(42.4)).toBe("42%");
    expect(formatContextWindowPercentage(99.6)).toBe("100%");
  });

  it("drops a trailing zero rather than showing 5.0%", () => {
    expect(formatContextWindowPercentage(5)).toBe("5%");
  });

  it("clamps out-of-range values and rejects missing ones", () => {
    expect(formatContextWindowPercentage(140)).toBe("100%");
    expect(formatContextWindowPercentage(-4)).toBe("0%");
    expect(formatContextWindowPercentage(null)).toBeNull();
    expect(formatContextWindowPercentage(Number.NaN)).toBeNull();
  });
});

describe("hasContextWindowFill", () => {
  it("needs both a window and a percentage", () => {
    expect(hasContextWindowFill({ maxTokens: 200_000, usedPercentage: 12 })).toBe(true);
    expect(hasContextWindowFill({ maxTokens: null, usedPercentage: 12 })).toBe(false);
    expect(hasContextWindowFill({ maxTokens: 200_000, usedPercentage: null })).toBe(false);
  });
});

describe("contextWindowRows", () => {
  const base = {
    usedTokens: 1_000,
    totalProcessedTokens: null,
    maxTokens: 200_000,
    remainingTokens: 199_000,
    usedPercentage: 0.5,
    remainingPercentage: 99.5,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    autoCompactThreshold: null,
    promptCache: null,
    updatedAt: "2026-09-21T10:00:00.000Z",
  } satisfies ContextWindowSnapshot;

  it("drops the figures a provider did not report", () => {
    expect(contextWindowRows(base).map((row) => row.key)).toEqual(["remaining"]);
  });

  it("keeps every reported figure, richest provider first", () => {
    const rows = contextWindowRows({
      ...base,
      totalProcessedTokens: 50_000,
      inputTokens: 40_000,
      cachedInputTokens: 30_000,
      outputTokens: 10_000,
      reasoningOutputTokens: 4_000,
      lastUsedTokens: 900,
    });

    expect(rows.map((row) => row.key)).toEqual([
      "remaining",
      "lastTurn",
      "processed",
      "input",
      "cached",
      "output",
      "reasoning",
    ]);
  });
});
