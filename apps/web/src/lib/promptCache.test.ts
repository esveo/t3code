import { describe, expect, it } from "vite-plus/test";

import {
  asPromptCacheWindow,
  formatIdleDuration,
  msUntilPromptCacheStateChanges,
  resolvePromptCacheState,
} from "./promptCache";

const refreshedAt = "2026-09-21T12:00:00.000Z";
const at = (offsetMs: number) => Date.parse(refreshedAt) + offsetMs;

describe("resolvePromptCacheState", () => {
  it("counts whole minutes down from the last request", () => {
    const window = { ttl: "5m", refreshedAt } as const;
    expect(resolvePromptCacheState(window, at(0))).toMatchObject({
      kind: "warm",
      minutesLeft: 5,
    });
    expect(resolvePromptCacheState(window, at(4 * 60_000 + 1))).toMatchObject({
      kind: "warm",
      minutesLeft: 1,
    });
    expect(resolvePromptCacheState(window, at(5 * 60_000))).toEqual({
      kind: "cold",
      idleMs: 5 * 60_000,
    });
  });

  it("never shows more than one TTL when the client clock runs behind", () => {
    const state = resolvePromptCacheState({ ttl: "1h", refreshedAt }, at(-10 * 60_000));
    expect(state).toMatchObject({ kind: "warm", minutesLeft: 60 });
  });
});

describe("msUntilPromptCacheStateChanges", () => {
  it("waits for the next minute boundary and stops once cold", () => {
    const window = { ttl: "5m", refreshedAt } as const;
    expect(msUntilPromptCacheStateChanges(resolvePromptCacheState(window, at(15_000)))).toBe(
      45_000,
    );
    expect(msUntilPromptCacheStateChanges(resolvePromptCacheState(window, at(60_000)))).toBe(
      60_000,
    );
    expect(msUntilPromptCacheStateChanges(resolvePromptCacheState(window, at(400_000)))).toBe(null);
  });
});

describe("asPromptCacheWindow", () => {
  it("accepts only a known TTL with a parseable time", () => {
    expect(asPromptCacheWindow({ ttl: "1h", refreshedAt })).toEqual({ ttl: "1h", refreshedAt });
    expect(asPromptCacheWindow({ ttl: "10m", refreshedAt })).toBeNull();
    expect(asPromptCacheWindow({ ttl: "5m", refreshedAt: "later" })).toBeNull();
    expect(asPromptCacheWindow(undefined)).toBeNull();
  });
});

describe("formatIdleDuration", () => {
  it("grows from minutes to hours to days", () => {
    expect(formatIdleDuration(12 * 60_000)).toBe("12m");
    expect(formatIdleDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatIdleDuration(26 * 60 * 60_000)).toBe("1d 2h");
  });
});
