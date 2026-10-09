/**
 * Fork: user insights. List prices of the models user insights can run on,
 * for costs the Claude CLI does not report (or makes up for a model it does
 * not know yet) and for the import estimate.
 */
import type { UserInsightsModelId } from "@t3tools/contracts";

export interface ModelPricing {
  /** List prices in USD per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /**
   * `--max-budget-usd` per call. A CLI that does not know the model yet
   * prices it with a fallback far above its real price, so a new model gets
   * more room than its own price would need; our own cap uses the real price.
   */
  readonly maxBudgetUsd: number;
}

/** Per model, for when the CLI reports no cost or prices the model as unknown. */
export const MODEL_PRICING: Record<UserInsightsModelId, ModelPricing> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    maxBudgetUsd: 0.25,
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, maxBudgetUsd: 0.05 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    maxBudgetUsd: 0.15,
  },
};

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** What `tokens` cost on `model` at list price, in USD. */
export function priceTokens(model: UserInsightsModelId, tokens: TokenCounts): number {
  const price = MODEL_PRICING[model];
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheCreationTokens * price.cacheWrite) /
    1_000_000
  );
}
