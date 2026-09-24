import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answersLatestPrompt,
  childUpdateBody,
  childUpdateFor,
} from "./ThreadOrchestrationReactor.ts";

const shell = (overrides: Partial<OrchestrationThreadShell>) =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    pullRequests: [],
    planProgress: null,
    updatedAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  }) as OrchestrationThreadShell;

const running = shell({
  session: {
    status: "running",
    updatedAt: "2026-09-23T10:01:00.000Z",
  } as OrchestrationThreadShell["session"],
});
const settled = shell({
  session: {
    status: "ready",
    updatedAt: "2026-09-23T10:02:00.000Z",
  } as OrchestrationThreadShell["session"],
});

describe("childUpdateFor", () => {
  it("stays quiet while the child works", () => {
    expect(
      childUpdateFor({
        child: running,
        latestPromptId: null,
        latestAnswerId: "m1",
        requestActivityId: undefined,
      }),
    ).toBe(null);
  });

  it("keys a finished child by its latest answer, so one finish is reported once", () => {
    const first = childUpdateFor({
      child: settled,
      latestPromptId: null,
      latestAnswerId: "m1",
      requestActivityId: undefined,
    });
    const again = childUpdateFor({
      child: settled,
      latestPromptId: null,
      latestAnswerId: "m1",
      requestActivityId: undefined,
    });
    const next = childUpdateFor({
      child: settled,
      latestPromptId: null,
      latestAnswerId: "m2",
      requestActivityId: undefined,
    });
    expect(first).toEqual({ key: "done:m1", state: "done" });
    expect(again?.key).toBe(first?.key);
    expect(next?.key).not.toBe(first?.key);
  });

  it("reports a child once, after its background tasks and the turn they wake", () => {
    const update = (child: OrchestrationThreadShell, latestAnswerId: string) =>
      childUpdateFor({ child, latestPromptId: null, latestAnswerId, requestActivityId: undefined });
    // The turn ends with an interim answer while eight subagents run on.
    const turnEndedWithSubagents = shell({ ...settled, backgroundLiveness: "working" });
    expect(update(turnEndedWithSubagents, "interim")).toBe(null);
    // The last subagent reports back and wakes the agent for a new turn.
    expect(update(running, "interim")).toBe(null);
    // That turn ends with the report.
    const finished = update(settled, "report");
    expect(finished).toEqual({ key: "done:report", state: "done" });
    // The grace-period check after the last task ended finds the same finish.
    expect(update(settled, "report")?.key).toBe(finished?.key);
  });

  it("reports a blocked child once per request it waits on", () => {
    const waiting = shell({ ...running, hasPendingUserInput: true });
    expect(
      childUpdateFor({
        child: waiting,
        latestPromptId: null,
        latestAnswerId: null,
        requestActivityId: "a1",
      }),
    ).toEqual({
      key: "waiting:a1",
      state: "waiting",
    });
    // A session write while it waits is not a new request.
    expect(
      childUpdateFor({
        child: waiting,
        latestPromptId: null,
        latestAnswerId: null,
        requestActivityId: undefined,
      }),
    ).toBe(null);
  });

  it("reports a failure even before the child answered", () => {
    const failed = shell({
      session: {
        status: "error",
        updatedAt: "2026-09-23T10:03:00.000Z",
      } as OrchestrationThreadShell["session"],
    });
    expect(
      childUpdateFor({
        child: failed,
        latestPromptId: null,
        latestAnswerId: null,
        requestActivityId: undefined,
      }),
    ).toEqual({
      key: "failed:2026-09-23T10:03:00.000Z",
      state: "failed",
    });
  });
});

describe("childUpdateFor follow-ups", () => {
  it("reports a retry that fails again without a new answer", () => {
    const failed = shell({
      session: {
        status: "error",
        updatedAt: "2026-09-23T10:03:00.000Z",
      } as OrchestrationThreadShell["session"],
    });
    const update = (latestPromptId: string) =>
      childUpdateFor({
        child: failed,
        latestPromptId,
        latestAnswerId: "a1",
        requestActivityId: undefined,
      });
    // The coordinator's send_to_thread adds a new prompt before each retry.
    expect(update("u2")?.key).not.toBe(update("u1")?.key);
    // A repeated session write within one retry stays one update.
    expect(update("u2")?.key).toBe(update("u2")?.key);
  });
});

describe("answersLatestPrompt", () => {
  const at = (createdAt: string) => ({ createdAt });
  it("passes on an answer only when it came after the latest prompt", () => {
    expect(answersLatestPrompt(at("2026-09-23T10:02:00Z"), at("2026-09-23T10:01:00Z"))).toBe(true);
    expect(answersLatestPrompt(at("2026-09-23T10:02:00Z"), null)).toBe(true);
    // A retry that failed before answering keeps the old answer out of its update.
    expect(answersLatestPrompt(at("2026-09-23T10:02:00Z"), at("2026-09-23T10:03:00Z"))).toBe(false);
    expect(answersLatestPrompt(null, at("2026-09-23T10:03:00Z"))).toBe(false);
  });
});

describe("childUpdateBody", () => {
  it("passes on the answer and tells a blocked child's coordinator what it can do", () => {
    expect(childUpdateBody({ state: "done", latestAnswer: "Fixed in four places." })).toBe(
      "Fixed in four places.",
    );
    expect(childUpdateBody({ state: "done", latestAnswer: null })).toBe("(It gave no answer.)");
    expect(childUpdateBody({ state: "waiting", latestAnswer: null })).toContain("send_to_thread");
  });
});
