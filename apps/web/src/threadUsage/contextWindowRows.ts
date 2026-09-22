import type { ContextWindowSnapshot } from "~/lib/contextWindow";

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
