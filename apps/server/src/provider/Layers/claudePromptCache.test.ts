import { describe, expect, it } from "vite-plus/test";

import { nextClaudePromptCacheState } from "./claudePromptCache.ts";

const observedAt = "2026-09-17T10:00:00.000Z";

describe("nextClaudePromptCacheState", () => {
  it("uses the 1-hour TTL when 1-hour tokens were written, even alongside 5-minute ones", () => {
    expect(
      nextClaudePromptCacheState({
        previous: undefined,
        observedAt,
        usage: {
          cache_creation_input_tokens: 900,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 700 },
        },
      }),
    ).toEqual({ refreshedAt: observedAt, ttlSeconds: 3600 });
  });

  it("uses the 5-minute TTL when only 5-minute tokens were written", () => {
    expect(
      nextClaudePromptCacheState({
        previous: { refreshedAt: "2026-09-17T09:00:00.000Z", ttlSeconds: 3600 },
        observedAt,
        usage: {
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
        },
      }),
    ).toEqual({ refreshedAt: observedAt, ttlSeconds: 300 });
  });

  it("keeps the known TTL for a pure cache read and defaults to 5 minutes without one", () => {
    const readOnly = { cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };
    expect(
      nextClaudePromptCacheState({
        previous: { refreshedAt: "2026-09-17T09:00:00.000Z", ttlSeconds: 3600 },
        observedAt,
        usage: readOnly,
      }),
    ).toEqual({ refreshedAt: observedAt, ttlSeconds: 3600 });
    expect(
      nextClaudePromptCacheState({ previous: undefined, observedAt, usage: readOnly }),
    ).toEqual({ refreshedAt: observedAt, ttlSeconds: 300 });
  });

  it("leaves the state untouched when the request did not use the cache", () => {
    const previous = { refreshedAt: "2026-09-17T09:59:00.000Z", ttlSeconds: 300 };
    expect(
      nextClaudePromptCacheState({
        previous,
        observedAt,
        usage: { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: null },
      }),
    ).toBe(previous);
    expect(nextClaudePromptCacheState({ previous, observedAt, usage: undefined })).toBe(previous);
  });
});
