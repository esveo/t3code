/**
 * Prompt-cache bookkeeping for the Claude adapter.
 *
 * Anthropic keeps a prompt-cache entry for 5 minutes (or 1 hour when the
 * request asked for the 1-hour TTL), and every request that reads or writes
 * the entry restarts that clock. The adapter records when the main agent last
 * touched the cache and which TTL applies, and attaches both to its token-usage
 * snapshots so clients can count down to expiry.
 */

export const CLAUDE_PROMPT_CACHE_DEFAULT_TTL_SECONDS = 5 * 60;
export const CLAUDE_PROMPT_CACHE_LONG_TTL_SECONDS = 60 * 60;

export interface ClaudePromptCacheState {
  readonly refreshedAt: string;
  readonly ttlSeconds: number;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Folds one main-agent API usage payload (an assistant message's
 * `message.usage` or a `message_delta` usage) into the prompt-cache state.
 *
 * Returns the previous state when the request neither read nor wrote the
 * cache. The TTL comes from `cache_creation.ephemeral_{1h,5m}_input_tokens`
 * (1 hour wins when both were written); a pure cache read carries no TTL, so
 * it keeps the previously observed TTL, falling back to 5 minutes.
 */
export function nextClaudePromptCacheState(input: {
  readonly previous: ClaudePromptCacheState | undefined;
  readonly usage: unknown;
  readonly observedAt: string;
}): ClaudePromptCacheState | undefined {
  const usage = asRecord(input.usage);
  if (!usage) {
    return input.previous;
  }
  const creation = asRecord(usage.cache_creation);
  const wrote1h = positiveNumber(creation?.ephemeral_1h_input_tokens);
  const wrote5m = positiveNumber(creation?.ephemeral_5m_input_tokens);
  const touchedCache =
    wrote1h ||
    wrote5m ||
    positiveNumber(usage.cache_creation_input_tokens) ||
    positiveNumber(usage.cache_read_input_tokens);
  if (!touchedCache) {
    return input.previous;
  }
  const ttlSeconds = wrote1h
    ? CLAUDE_PROMPT_CACHE_LONG_TTL_SECONDS
    : wrote5m
      ? CLAUDE_PROMPT_CACHE_DEFAULT_TTL_SECONDS
      : (input.previous?.ttlSeconds ?? CLAUDE_PROMPT_CACHE_DEFAULT_TTL_SECONDS);
  return { refreshedAt: input.observedAt, ttlSeconds };
}
