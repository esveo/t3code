import { describe, expect, it } from "@effect/vitest";

import { parseRateTable } from "./usagePricing.ts";
import {
  resumeSessionIds,
  summarizeSessionRecords,
  usageProviderForDriver,
} from "./threadSessionUsage.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates = parseRateTable({
  "claude-sonnet-4": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
  },
});

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: "claude",
  timestampMs: 1_700_000_000_000,
  model: "claude-sonnet-4",
  sessionId: "session-a",
  totals: {
    uncachedInputTokens: 1_000,
    cachedInputTokens: 10_000,
    cacheCreationTokens: 2_000,
    outputTokens: 500,
    reasoningTokens: 100,
  },
  reportedCostUsd: null,
  dedupeKey: null,
  ...overrides,
});

const summarize = (records: readonly UsageRecord[], sessionIds = ["session-a"]) =>
  summarizeSessionRecords({
    records,
    sessionIds: new Set(sessionIds),
    rates,
    priceOverrides: new Map(),
  });

describe("thread session usage", () => {
  it("counts only the thread's own sessions", () => {
    const summary = summarize([
      record(),
      record({ sessionId: "session-b" }),
      record({ sessionId: "session-a", timestampMs: 1_700_000_060_000 }),
    ]);

    expect(summary.records).toBe(2);
    expect(summary.totals.outputTokens).toBe(1_000);
    expect(summary.firstRecordAtMs).toBe(1_700_000_000_000);
    expect(summary.lastRecordAtMs).toBe(1_700_000_060_000);
  });

  it("prices each token class at its own rate", () => {
    const summary = summarize([record()]);

    // 1k fresh input, 10k cache reads, 2k cache writes, 500 output.
    expect(summary.costUsd).toBeCloseTo(0.003 + 0.003 + 0.0075 + 0.0075, 10);
    // Cache reads at full input rate would have cost 0.03.
    expect(summary.cacheSavingsUsd).toBeCloseTo(0.027, 10);
  });

  it("drops records repeated across transcripts", () => {
    const summary = summarize([
      record({ dedupeKey: "session-a:prompt-1" }),
      record({ dedupeKey: "session-a:prompt-1" }),
    ]);

    expect(summary.records).toBe(1);
  });

  it("reports the provider's own cost where it gave one", () => {
    const summary = summarize([
      record({ reportedCostUsd: 0.5 }),
      record({ reportedCostUsd: 0.25 }),
    ]);

    expect(summary.models).toHaveLength(1);
    expect(summary.models[0]?.costSource).toBe("providerReported");
    expect(summary.costUsd).toBeCloseTo(0.75, 10);
  });

  it("splits a thread that switched models, dearest first", () => {
    const summary = summarize([
      record({ model: "unknown-model" }),
      record({ model: "claude-sonnet-4" }),
    ]);

    expect(summary.models.map((model) => model.model)).toEqual([
      "claude-sonnet-4",
      "unknown-model",
    ]);
    expect(summary.models[1]?.costSource).toBe("unpriced");
    // Unpriced tokens still count towards the thread's totals.
    expect(summary.totals.uncachedInputTokens).toBe(2_000);
  });

  it("reads the session id each adapter writes", () => {
    expect(resumeSessionIds({ resume: "claude-session" }, "claude")).toEqual(["claude-session"]);
    expect(resumeSessionIds({ threadId: "codex-thread" }, "codex")).toEqual(["codex-thread"]);
    expect(resumeSessionIds({ sessionId: "grok-session", schemaVersion: 1 }, "grok")).toEqual([
      "grok-session",
    ]);
    expect(resumeSessionIds({ resume: "  " }, "claude")).toEqual([]);
    expect(resumeSessionIds(null, "claude")).toEqual([]);
  });

  it("ignores T3's own thread id in a Claude cursor", () => {
    expect(resumeSessionIds({ threadId: "t3-thread", resume: "claude-session" }, "claude")).toEqual(
      ["claude-session"],
    );
    expect(resumeSessionIds({ threadId: "t3-thread" }, "claude")).toEqual([]);
  });

  it("maps only the drivers whose transcripts are scanned", () => {
    expect(usageProviderForDriver("claudeAgent")).toBe("claude");
    expect(usageProviderForDriver("codex")).toBe("codex");
    expect(usageProviderForDriver("cursor")).toBeNull();
    expect(usageProviderForDriver(null)).toBeNull();
  });
});
