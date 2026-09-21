import type { ContextWindowSnapshot } from "~/lib/contextWindow";

export type ContextWindowTone = "normal" | "warning" | "critical";

/**
 * The share of the window a thread may use before it is compacted.
 *
 * A provider that compacts automatically never reaches 100%, so a bar drawn
 * against the raw window looks calm while the thread is one turn away from
 * losing its history. The threshold is the limit the user actually hits.
 */
export function resolveContextWindowLimitPercentage(
  usage: Pick<
    ContextWindowSnapshot,
    "maxTokens" | "compactsAutomatically" | "autoCompactThreshold"
  >,
): number | null {
  const maxTokens = usage.maxTokens ?? null;
  const autoCompactThreshold = usage.autoCompactThreshold ?? null;
  if (
    !usage.compactsAutomatically ||
    maxTokens === null ||
    maxTokens <= 0 ||
    autoCompactThreshold === null ||
    autoCompactThreshold <= 0 ||
    autoCompactThreshold >= maxTokens
  ) {
    return null;
  }
  return (autoCompactThreshold / maxTokens) * 100;
}

/**
 * How alarming the fill should look, measured against whichever limit the
 * thread hits first: the compaction threshold, or the window itself.
 */
export function resolveContextWindowTone(
  usage: Pick<
    ContextWindowSnapshot,
    "usedPercentage" | "maxTokens" | "compactsAutomatically" | "autoCompactThreshold"
  >,
): ContextWindowTone {
  const usedPercentage = usage.usedPercentage ?? null;
  if (usedPercentage === null || !Number.isFinite(usedPercentage)) {
    return "normal";
  }
  const limitPercentage = resolveContextWindowLimitPercentage(usage) ?? 100;
  const ratio = usedPercentage / limitPercentage;
  if (ratio >= 1) return "critical";
  if (ratio >= 0.8) return "warning";
  return "normal";
}

/**
 * The number shown next to the bar. Keeps a digit of precision below 10% so a
 * fresh thread does not sit at a flat "0%" for its first few turns.
 */
export function formatContextWindowPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped < 10) {
    return `${clamped.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(clamped)}%`;
}

/** Whether there is enough in the snapshot to draw a fill rather than a count. */
export function hasContextWindowFill(
  usage: Pick<ContextWindowSnapshot, "maxTokens" | "usedPercentage">,
): boolean {
  const maxTokens = usage.maxTokens ?? null;
  const usedPercentage = usage.usedPercentage ?? null;
  return (
    maxTokens !== null &&
    maxTokens > 0 &&
    usedPercentage !== null &&
    Number.isFinite(usedPercentage)
  );
}

export interface ContextWindowRow {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
}

/**
 * The exact figures a provider reported for this thread, and nothing else.
 *
 * Providers report totals, never a breakdown by system prompt, tool schema or
 * message, so there is no honest way to say what fills the window. What they
 * do report differs per provider, which is why every row is dropped rather
 * than zeroed when it is missing.
 */
export function contextWindowRows(usage: ContextWindowSnapshot): readonly ContextWindowRow[] {
  const rows: ContextWindowRow[] = [];
  const push = (key: string, label: string, value: number | null | undefined) => {
    if (value !== null && value !== undefined && Number.isFinite(value) && value > 0) {
      rows.push({ key, label, tokens: value });
    }
  };
  push("remaining", "Remaining", usage.remainingTokens);
  push("lastTurn", "Last turn", usage.lastUsedTokens);
  push("processed", "Total processed", usage.totalProcessedTokens);
  push("input", "Input processed", usage.inputTokens);
  push("cached", "Read from cache", usage.cachedInputTokens);
  push("output", "Output produced", usage.outputTokens);
  push("reasoning", "of which reasoning", usage.reasoningOutputTokens);
  return rows;
}
