import { describe, expect, it } from "@effect/vitest";

import { parseClaudeResult } from "./HaikuCli.ts";

const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1800,
  structured_output: { ops: [] },
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 300,
  },
};

describe("parseClaudeResult", () => {
  it("reads the object envelope with its reported cost", () => {
    expect(parseClaudeResult(JSON.stringify(result))).toEqual({
      structuredOutput: { ops: [] },
      isError: false,
      errorText: null,
      usage: {
        model: "claude-haiku-5-5",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 5000,
        cacheCreationTokens: 300,
        costUsd: 0.0123,
        costEstimated: false,
        durationMs: 1800,
      },
    });
  });

  it("uses the last result entry of an array envelope", () => {
    const parsed = parseClaudeResult(
      JSON.stringify([{ type: "system" }, { type: "assistant" }, result]),
    );
    expect(parsed?.structuredOutput).toEqual({ ops: [] });
  });

  it("estimates the cost when usage or cost is missing", () => {
    const { total_cost_usd: _cost, ...withoutCost } = result;
    const estimated = parseClaudeResult(JSON.stringify(withoutCost), "claude-haiku-4-5");
    expect(estimated?.usage.costEstimated).toBe(true);
    expect(estimated?.usage.costUsd).toBeCloseTo(
      1000 / 1e6 + (200 * 5) / 1e6 + (5000 * 0.1) / 1e6 + (300 * 1.25) / 1e6,
    );
    const bare = parseClaudeResult(JSON.stringify({ type: "result", structured_output: {} }));
    expect(bare?.usage).toMatchObject({ inputTokens: 0, costUsd: 0, costEstimated: true });
  });

  it("prices a model the CLI does not know yet itself, at the chosen model's prices", () => {
    const parsed = parseClaudeResult(
      JSON.stringify({
        ...result,
        total_cost_usd: 0.0054,
        modelUsage: { "claude-haiku-5-5": { costBasis: "unknown" } },
      }),
      "claude-haiku-5-5",
    );
    expect(parsed?.usage).toMatchObject({ model: "claude-haiku-5-5", costEstimated: true });
    expect(parsed?.usage.costUsd).toBeCloseTo(
      (1000 * 0.1 + 200 * 0.5 + 5000 * 0.01 + 300 * 0.125) / 1e6,
    );
  });

  it("reports errors with their text", () => {
    const parsed = parseClaudeResult(
      JSON.stringify({ ...result, is_error: true, subtype: "error_max_budget_usd", result: "" }),
    );
    expect(parsed).toMatchObject({ isError: true, errorText: "error_max_budget_usd" });
  });

  it("returns null for output that is not an envelope", () => {
    expect(parseClaudeResult("not json")).toBeNull();
    expect(parseClaudeResult(JSON.stringify([{ type: "assistant" }]))).toBeNull();
  });
});
