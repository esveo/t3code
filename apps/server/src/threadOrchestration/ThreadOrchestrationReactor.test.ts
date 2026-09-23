import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { childUpdateBody, childUpdateFor } from "./ThreadOrchestrationReactor.ts";

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
      childUpdateFor({ child: running, latestAnswerId: "m1", requestActivityId: undefined }),
    ).toBe(null);
  });

  it("keys a finished child by its latest answer, so one finish is reported once", () => {
    const first = childUpdateFor({
      child: settled,
      latestAnswerId: "m1",
      requestActivityId: undefined,
    });
    const again = childUpdateFor({
      child: settled,
      latestAnswerId: "m1",
      requestActivityId: undefined,
    });
    const next = childUpdateFor({
      child: settled,
      latestAnswerId: "m2",
      requestActivityId: undefined,
    });
    expect(first).toEqual({ key: "done:m1", state: "done" });
    expect(again?.key).toBe(first?.key);
    expect(next?.key).not.toBe(first?.key);
  });

  it("reports a blocked child once per request it waits on", () => {
    const waiting = shell({ ...running, hasPendingUserInput: true });
    expect(
      childUpdateFor({ child: waiting, latestAnswerId: null, requestActivityId: "a1" }),
    ).toEqual({
      key: "waiting:a1",
      state: "waiting",
    });
    // A session write while it waits is not a new request.
    expect(
      childUpdateFor({ child: waiting, latestAnswerId: null, requestActivityId: undefined }),
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
      childUpdateFor({ child: failed, latestAnswerId: null, requestActivityId: undefined }),
    ).toEqual({
      key: "failed:2026-09-23T10:03:00.000Z",
      state: "failed",
    });
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
