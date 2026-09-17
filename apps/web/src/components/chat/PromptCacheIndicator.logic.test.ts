import { describe, expect, it } from "vite-plus/test";

import {
  derivePromptCacheStatus,
  describePromptCacheStatus,
  formatPromptCacheRemaining,
  formatPromptCacheTtl,
} from "./PromptCacheIndicator.logic";

const refreshedAt = "2026-09-17T10:00:00.000Z";
const refreshedAtMs = Date.parse(refreshedAt);

describe("derivePromptCacheStatus", () => {
  it("is hidden without cache info from the provider", () => {
    expect(
      derivePromptCacheStatus({ refreshedAt: null, ttlSeconds: 300, turnRunning: false, nowMs: 0 }),
    ).toBeNull();
    expect(
      derivePromptCacheStatus({ refreshedAt, ttlSeconds: null, turnRunning: false, nowMs: 0 }),
    ).toBeNull();
  });

  it("reports refreshing while a turn runs, even past the TTL", () => {
    expect(
      derivePromptCacheStatus({
        refreshedAt,
        ttlSeconds: 300,
        turnRunning: true,
        nowMs: refreshedAtMs + 3_600_000,
      }),
    ).toEqual({ kind: "refreshing", ttlSeconds: 300 });
  });

  it("counts down, warns in the last minute, then expires", () => {
    const at = (elapsedMs: number) =>
      derivePromptCacheStatus({
        refreshedAt,
        ttlSeconds: 300,
        turnRunning: false,
        nowMs: refreshedAtMs + elapsedMs,
      });
    expect(at(48_000)).toEqual({
      kind: "counting",
      ttlSeconds: 300,
      remainingMs: 252_000,
      warning: false,
    });
    expect(at(240_000)).toMatchObject({ kind: "counting", remainingMs: 60_000, warning: true });
    expect(at(300_000)).toEqual({ kind: "expired", ttlSeconds: 300 });
  });

  it("caps the countdown at the TTL when the client clock runs behind", () => {
    expect(
      derivePromptCacheStatus({
        refreshedAt,
        ttlSeconds: 3600,
        turnRunning: false,
        nowMs: refreshedAtMs - 30_000,
      }),
    ).toMatchObject({ kind: "counting", remainingMs: 3_600_000 });
  });
});

describe("prompt cache formatting", () => {
  it("formats remaining time rounded up to whole seconds", () => {
    expect(formatPromptCacheRemaining(252_000)).toBe("4:12");
    expect(formatPromptCacheRemaining(59_001)).toBe("1:00");
    expect(formatPromptCacheRemaining(3_600_000)).toBe("60:00");
    expect(formatPromptCacheRemaining(-5)).toBe("0:00");
  });

  it("names the TTL and explains the consequence", () => {
    expect(formatPromptCacheTtl(300)).toBe("5-minute cache");
    expect(formatPromptCacheTtl(3600)).toBe("1-hour cache");
    expect(
      describePromptCacheStatus({
        kind: "counting",
        ttlSeconds: 300,
        remainingMs: 252_000,
        warning: false,
      }),
    ).toBe(
      "Prompt cache expires in 4:12 (5-minute cache). After that the next message re-reads the full context.",
    );
  });
});
