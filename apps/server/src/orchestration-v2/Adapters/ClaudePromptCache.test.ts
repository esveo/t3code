import { assert, it } from "@effect/vitest";

import { makeClaudePromptCacheTracker } from "./ClaudePromptCache.ts";

const wrote5m = {
  input_tokens: 10,
  cache_creation_input_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
};
const readOnly = { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 };

it("keeps the request time across snapshots of one message", () => {
  const track = makeClaudePromptCacheTracker();
  const first = track({ providerThreadId: "pt", messageId: "m1", usage: wrote5m, now: "t1" });
  const later = track({ providerThreadId: "pt", messageId: "m1", usage: wrote5m, now: "t2" });
  assert.deepStrictEqual(first, { promptCache: { ttl: "5m", refreshedAt: "t1" } });
  assert.deepStrictEqual(later, { promptCache: { ttl: "5m", refreshedAt: "t1" } });
});

it("keeps the written TTL when a later request only reads the cache", () => {
  const track = makeClaudePromptCacheTracker();
  track({ providerThreadId: "pt", messageId: "m1", usage: wrote5m, now: "t1" });
  assert.deepStrictEqual(
    track({ providerThreadId: "pt", messageId: "m2", usage: readOnly, now: "t2" }),
    { promptCache: { ttl: "5m", refreshedAt: "t2" } },
  );
});

it("reports nothing cached for a response without cache tokens", () => {
  const track = makeClaudePromptCacheTracker();
  track({ providerThreadId: "pt", messageId: "m1", usage: wrote5m, now: "t1" });
  assert.deepStrictEqual(
    track({ providerThreadId: "pt", messageId: "m2", usage: { input_tokens: 10 }, now: "t2" }),
    {},
  );
});
