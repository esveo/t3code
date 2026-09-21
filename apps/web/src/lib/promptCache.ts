import type { PromptCacheWindow } from "@t3tools/contracts";

const TTL_MS: Record<PromptCacheWindow["ttl"], number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

export type PromptCacheState =
  | {
      readonly kind: "warm";
      readonly ttl: PromptCacheWindow["ttl"];
      readonly msLeft: number;
      readonly minutesLeft: number;
    }
  | { readonly kind: "cold"; readonly idleMs: number };

/** Reads a `promptCache` field from an untrusted context-window activity payload. */
export function asPromptCacheWindow(value: unknown): PromptCacheWindow | null {
  if (!value || typeof value !== "object") return null;
  const { ttl, refreshedAt } = value as Record<string, unknown>;
  if ((ttl !== "5m" && ttl !== "1h") || typeof refreshedAt !== "string") return null;
  return Number.isNaN(Date.parse(refreshedAt)) ? null : { ttl, refreshedAt };
}

/**
 * Whether the prompt cache is still warm at `now`. The provider keeps it for
 * one TTL after the last request, so the next message after that pays to
 * write the whole conversation into the cache again.
 */
export function resolvePromptCacheState(window: PromptCacheWindow, now: number): PromptCacheState {
  const ttlMs = TTL_MS[window.ttl];
  const refreshedAt = Date.parse(window.refreshedAt);
  // Clamped so a clock ahead of the server's never shows more than one TTL.
  const msLeft = Math.min(ttlMs, refreshedAt + ttlMs - now);
  if (msLeft > 0) {
    return { kind: "warm", ttl: window.ttl, msLeft, minutesLeft: Math.ceil(msLeft / 60_000) };
  }
  return { kind: "cold", idleMs: now - refreshedAt };
}

/** Milliseconds until the displayed minute count next changes, or null once cold. */
export function msUntilPromptCacheStateChanges(state: PromptCacheState): number | null {
  if (state.kind === "cold") return null;
  const intoMinute = state.msLeft % 60_000;
  return intoMinute === 0 ? 60_000 : intoMinute;
}

export function formatIdleDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
