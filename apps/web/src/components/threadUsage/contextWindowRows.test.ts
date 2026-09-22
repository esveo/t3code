import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { contextWindowRows } from "./contextWindowRows";

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
