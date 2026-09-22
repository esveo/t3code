/**
 * Reading of one thread's usage report.
 *
 * The server answers with tokens, a cost and the provenance of the rates it
 * used. Everything here is about saying that honestly in a few lines: a cost
 * nobody can trace is worse than no cost at all.
 *
 * @module threadUsage.logic
 */
import type { ThreadUsageSummary, UsagePricing } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

/**
 * Cost with enough digits to be worth reading.
 *
 * A day of usage rounds to cents happily; a single thread often costs less
 * than one, and "$0.00" for real spending reads like a bug.
 */
export function formatThreadCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.995) return `$${value.toFixed(3)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export type ThreadUsageState = "unattributed" | "empty" | "ready";

export function threadUsageState(summary: ThreadUsageSummary): ThreadUsageState {
  if (!summary.matched) return "unattributed";
  return summary.records === 0 ? "empty" : "ready";
}

export interface ThreadTokenRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * The token classes, in the order they cost money.
 *
 * Reasoning is a subset of output rather than a class of its own, so it is
 * shown indented under it and never added to a total.
 */
export function threadTokenRows(summary: ThreadUsageSummary): readonly ThreadTokenRow[] {
  const totals = summary.totals;
  const rows: ThreadTokenRow[] = [
    { key: "input", label: "Fresh input", value: formatTokens(totals.uncachedInputTokens) },
    { key: "cacheRead", label: "Cache reads", value: formatTokens(totals.cachedInputTokens) },
    { key: "cacheWrite", label: "Cache writes", value: formatTokens(totals.cacheCreationTokens) },
    { key: "output", label: "Output", value: formatTokens(totals.outputTokens) },
  ];
  if (totals.reasoningTokens > 0) {
    rows.push({
      key: "reasoning",
      label: "of which reasoning",
      value: formatTokens(totals.reasoningTokens),
    });
  }
  return rows;
}

/** Total tokens billed, which excludes reasoning because output already counts it. */
export function threadTotalTokens(summary: ThreadUsageSummary): number {
  const totals = summary.totals;
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Where the cost figure came from.
 *
 * A thread priced from the rate table and one the provider reported itself
 * are worth different amounts of trust, and an unpriced model is worth none.
 */
export function threadCostNote(summary: ThreadUsageSummary, pricing: UsagePricing): string {
  const unpriced = summary.models.filter((model) => model.costSource === "unpriced");
  if (unpriced.length > 0 && unpriced.length === summary.models.length) {
    return "No rates for this model, so only tokens are counted.";
  }
  const missing =
    unpriced.length > 0
      ? ` ${unpriced.length} model's tokens have no rates and cost nothing here.`
      : "";
  if (summary.models.every((model) => model.costSource === "providerReported")) {
    return `Cost as the provider reported it.${missing}`;
  }
  const rates =
    pricing.status === "unavailable"
      ? "estimated without a rate table"
      : pricing.status === "cached"
        ? "priced from the last rate table fetched"
        : "priced from the current rate table";
  return `API-equivalent cost, ${rates}. A subscription bills separately.${missing}`;
}
