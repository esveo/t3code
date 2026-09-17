/** Remaining time at or below which the countdown turns warning-coloured. */
export const PROMPT_CACHE_WARNING_MS = 60_000;

export type PromptCacheStatus =
  | { readonly kind: "refreshing"; readonly ttlSeconds: number }
  | {
      readonly kind: "counting";
      readonly ttlSeconds: number;
      readonly remainingMs: number;
      readonly warning: boolean;
    }
  | { readonly kind: "expired"; readonly ttlSeconds: number };

/**
 * Derives the prompt-cache countdown for a thread from the latest usage
 * snapshot's `promptCacheRefreshedAt` / `promptCacheTtlSeconds`. Returns null
 * when the provider reported no cache info (every provider but Claude), so the
 * indicator stays hidden. A running turn keeps refreshing the cache, so it
 * reports "refreshing" instead of a countdown.
 */
export function derivePromptCacheStatus(input: {
  readonly refreshedAt: string | null | undefined;
  readonly ttlSeconds: number | null | undefined;
  readonly turnRunning: boolean;
  readonly nowMs: number;
}): PromptCacheStatus | null {
  const { ttlSeconds } = input;
  if (!input.refreshedAt || typeof ttlSeconds !== "number" || !(ttlSeconds > 0)) {
    return null;
  }
  const refreshedAtMs = Date.parse(input.refreshedAt);
  if (!Number.isFinite(refreshedAtMs)) {
    return null;
  }
  if (input.turnRunning) {
    return { kind: "refreshing", ttlSeconds };
  }
  // A clock skewed behind the server must not show more than the full TTL.
  const remainingMs = Math.min(ttlSeconds * 1000, refreshedAtMs + ttlSeconds * 1000 - input.nowMs);
  if (remainingMs <= 0) {
    return { kind: "expired", ttlSeconds };
  }
  return {
    kind: "counting",
    ttlSeconds,
    remainingMs,
    warning: remainingMs <= PROMPT_CACHE_WARNING_MS,
  };
}

/** `m:ss`, rounded up so the display reaches 0:00 exactly at expiry. */
export function formatPromptCacheRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** "5-minute cache", "1-hour cache". */
export function formatPromptCacheTtl(ttlSeconds: number): string {
  if (ttlSeconds % 3600 === 0) {
    const hours = ttlSeconds / 3600;
    return `${hours}-hour cache`;
  }
  const minutes = Math.round(ttlSeconds / 60);
  return `${minutes}-minute cache`;
}

export function describePromptCacheStatus(status: PromptCacheStatus): string {
  const ttl = formatPromptCacheTtl(status.ttlSeconds);
  switch (status.kind) {
    case "refreshing":
      return `Prompt cache is kept warm while the agent works (${ttl}).`;
    case "counting":
      return `Prompt cache expires in ${formatPromptCacheRemaining(status.remainingMs)} (${ttl}). After that the next message re-reads the full context.`;
    case "expired":
      return `Prompt cache expired (${ttl}). The next message re-reads the full context at full input price.`;
  }
}
