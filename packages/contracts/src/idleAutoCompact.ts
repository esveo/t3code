/**
 * Fork: idle auto-compact for Claude threads. A thread whose 1h prompt cache
 * is about to expire gets `/compact` sent shortly before, so the next message
 * rewrites a summary instead of the whole transcript.
 *
 * @module idleAutoCompact
 */
import * as Schema from "effect/Schema";

/** Must stay below the 60-minute cache TTL, or the compact itself pays the rewrite. */
export const MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES = 5;
export const MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES = 59;
export const DEFAULT_IDLE_AUTO_COMPACT_AFTER_MINUTES = 55;
export const IdleAutoCompactAfterMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES,
    maximum: MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  }),
);

export const MIN_IDLE_AUTO_COMPACT_CONTEXT_TOKENS = 10_000;
export const DEFAULT_IDLE_AUTO_COMPACT_CONTEXT_TOKENS = 150_000;
export const IdleAutoCompactMinContextTokens = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_IDLE_AUTO_COMPACT_CONTEXT_TOKENS),
);

/** The server's `/compact` messages carry this id prefix, so clients can label them. */
export const IDLE_AUTO_COMPACT_MESSAGE_ID_PREFIX = "idle-compact:";

export function isIdleAutoCompactMessageId(messageId: string): boolean {
  return messageId.startsWith(IDLE_AUTO_COMPACT_MESSAGE_ID_PREFIX);
}
