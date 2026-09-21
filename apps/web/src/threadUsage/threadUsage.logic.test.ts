import { describe, expect, it } from "@effect/vitest";
import type { ThreadUsageSummary, UsagePricing } from "@t3tools/contracts";

import {
  formatThreadCost,
  threadCostNote,
  threadTokenRows,
  threadTotalTokens,
  threadUsageState,
} from "./threadUsage.logic";

const pricing: UsagePricing = {
  status: "fresh",
  source: "litellm",
  fetchedAt: "2026-09-21T00:00:00.000Z",
  knownModels: 500,
};

const summary = (overrides: Partial<ThreadUsageSummary> = {}): ThreadUsageSummary => ({
  provider: "claude",
  matched: true,
  models: [
    {
      model: "claude-sonnet-4",
      totals: {
        uncachedInputTokens: 1_000,
        cachedInputTokens: 10_000,
        cacheCreationTokens: 2_000,
        outputTokens: 500,
        reasoningTokens: 100,
      },
      costUsd: 0.021,
      cacheSavingsUsd: 0.027,
      costSource: "modelPriced",
      records: 4,
    },
  ],
  totals: {
    uncachedInputTokens: 1_000,
    cachedInputTokens: 10_000,
    cacheCreationTokens: 2_000,
    outputTokens: 500,
    reasoningTokens: 100,
  },
  costUsd: 0.021,
  cacheSavingsUsd: 0.027,
  records: 4,
  firstRecordAt: null,
  lastRecordAt: null,
  pricing,
  readAt: "2026-09-21T10:00:00.000Z",
  scanDurationMs: 12,
  ...overrides,
});

describe("thread usage reading", () => {
  it("keeps sub-cent costs readable", () => {
    expect(formatThreadCost(0.0214)).toBe("$0.021");
    expect(formatThreadCost(1.234)).toBe("$1.23");
    expect(formatThreadCost(1234.5)).toBe("$1,235");
    expect(formatThreadCost(0)).toBe("$0.00");
  });

  it("tells an unattributable thread from an idle one", () => {
    expect(threadUsageState(summary({ matched: false }))).toBe("unattributed");
    expect(threadUsageState(summary({ records: 0 }))).toBe("empty");
    expect(threadUsageState(summary())).toBe("ready");
  });

  it("never adds reasoning on top of output", () => {
    expect(threadTotalTokens(summary())).toBe(13_500);
    expect(threadTokenRows(summary()).map((row) => row.key)).toContain("reasoning");
    expect(
      threadTokenRows(
        summary({
          totals: {
            uncachedInputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 1,
            reasoningTokens: 0,
          },
        }),
      ).map((row) => row.key),
    ).not.toContain("reasoning");
  });

  it("says where the cost came from", () => {
    expect(threadCostNote(summary(), pricing)).toContain("API-equivalent");
    expect(
      threadCostNote(
        summary({
          models: [{ ...summary().models[0]!, costSource: "providerReported" }],
        }),
        pricing,
      ),
    ).toContain("provider reported");
    expect(
      threadCostNote(
        summary({ models: [{ ...summary().models[0]!, costSource: "unpriced" }] }),
        pricing,
      ),
    ).toContain("No rates");
  });
});
