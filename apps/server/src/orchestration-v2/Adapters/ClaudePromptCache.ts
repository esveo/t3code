/**
 * Fork: the prompt cache window behind the composer's cache timer.
 *
 * Claude reports what a response read from and wrote to its prompt cache, and
 * the TTL of what it wrote. Every main-conversation request refreshes that
 * cache, so the window is the TTL plus the time the request was made. The SDK
 * emits one assistant snapshot per content block of a message; only the first
 * snapshot of a message marks the request's time, later ones keep it.
 *
 * @module ClaudePromptCache
 */
import type { PromptCacheWindow } from "@t3tools/contracts";

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The TTL of the cache a Claude response wrote, from its `cache_creation` breakdown. */
function writtenTtl(usage: Record<string, unknown>): PromptCacheWindow["ttl"] | undefined {
  const creation = usage.cache_creation;
  if (!creation || typeof creation !== "object" || Array.isArray(creation)) return undefined;
  const breakdown = creation as Record<string, unknown>;
  if (tokens(breakdown.ephemeral_1h_input_tokens) > 0) return "1h";
  if (tokens(breakdown.ephemeral_5m_input_tokens) > 0) return "5m";
  return undefined;
}

/**
 * Remembers each provider thread's last cache window. A response that only
 * read the cache keeps the TTL the cache was written with; a response without
 * cache tokens means nothing is cached.
 */
export function makeClaudePromptCacheTracker() {
  const byProviderThread = new Map<
    string,
    { readonly messageId: string; readonly window: PromptCacheWindow | undefined }
  >();
  return (input: {
    readonly providerThreadId: string;
    readonly messageId: string;
    readonly usage: unknown;
    readonly now: string;
  }): { readonly promptCache?: PromptCacheWindow } => {
    if (!input.usage || typeof input.usage !== "object" || Array.isArray(input.usage)) return {};
    const usage = input.usage as Record<string, unknown>;
    const previous = byProviderThread.get(input.providerThreadId);
    const cachedTokens =
      tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens);
    const ttl = cachedTokens > 0 ? (writtenTtl(usage) ?? previous?.window?.ttl) : undefined;
    const refreshedAt =
      previous?.messageId === input.messageId && previous.window
        ? previous.window.refreshedAt
        : input.now;
    const window = ttl ? { ttl, refreshedAt } : undefined;
    byProviderThread.set(input.providerThreadId, { messageId: input.messageId, window });
    return window ? { promptCache: window } : {};
  };
}
