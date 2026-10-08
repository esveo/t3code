import { describe, expect, it } from "vite-plus/test";

import {
  isEnvironmentWideSkip,
  suggestionEligibility,
  type SuggestionEligibilityInput,
} from "./suggestionEligibility";

const base: SuggestionEligibilityInput = {
  enabled: true,
  environmentWaiting: false,
  isActivePane: true,
  documentVisible: true,
  documentFocused: true,
  thread: {
    latestRun: { runId: "run-1", status: "completed" },
    runtimeActive: false,
    isSubagent: false,
    hasPendingRuntimeRequest: false,
  },
  hasPendingRequests: false,
  promptEmpty: true,
  lastAskedRunId: null,
};

const thread = (overrides: Partial<NonNullable<SuggestionEligibilityInput["thread"]>>) => ({
  ...base.thread!,
  ...overrides,
});

const reasonOf = (overrides: Partial<SuggestionEligibilityInput>) => {
  const result = suggestionEligibility({ ...base, ...overrides });
  return result.eligible ? null : result.reason;
};

describe("suggestionEligibility", () => {
  it("asks about a finished turn in the focused active pane", () => {
    expect(suggestionEligibility(base)).toEqual({ eligible: true, runId: "run-1" });
  });

  it("blocks while the setting is off or the server said no for every thread", () => {
    expect(reasonOf({ enabled: false })).toBe("off");
    expect(reasonOf({ environmentWaiting: true })).toBe("environment-waiting");
  });

  it("blocks while a turn runs or did not complete", () => {
    expect(reasonOf({ thread: thread({ runtimeActive: true }) })).toBe("running");
    expect(
      reasonOf({ thread: thread({ latestRun: { runId: "run-1", status: "interrupted" } }) }),
    ).toBe("running");
    expect(reasonOf({ thread: thread({ latestRun: null }) })).toBe("no-turn");
  });

  it("blocks while the agent waits for an answer", () => {
    expect(reasonOf({ hasPendingRequests: true })).toBe("pending-request");
    expect(reasonOf({ thread: thread({ hasPendingRuntimeRequest: true }) })).toBe(
      "pending-request",
    );
  });

  it("leaves subagent threads, inactive panes and typed prompts alone", () => {
    expect(reasonOf({ thread: thread({ isSubagent: true }) })).toBe("subagent");
    expect(reasonOf({ isActivePane: false })).toBe("inactive-pane");
    expect(reasonOf({ promptEmpty: false })).toBe("prompt-not-empty");
  });

  it("asks once per turn, and only while the window has focus", () => {
    expect(reasonOf({ lastAskedRunId: "run-1" })).toBe("already-asked");
    expect(reasonOf({ lastAskedRunId: "run-0" })).toBeNull();
    expect(reasonOf({ documentFocused: false })).toBe("not-focused");
    expect(reasonOf({ documentVisible: false })).toBe("not-focused");
  });
});

describe("isEnvironmentWideSkip", () => {
  it("tells server-wide answers from per-turn ones", () => {
    expect(isEnvironmentWideSkip("not-ready")).toBe(true);
    expect(isEnvironmentWideSkip("paused")).toBe(true);
    expect(isEnvironmentWideSkip("cooldown")).toBe(false);
    expect(isEnvironmentWideSkip(null)).toBe(false);
  });
});
