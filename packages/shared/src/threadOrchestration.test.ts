import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeChildThread,
  parseTaggedThreadMessage,
  parseThreadLinkHref,
  parseThreadUpdates,
  plainTextOfThreadMessage,
  readableThreadMessage,
  resolveChildThreadState,
  threadLinkHref,
  wrapFromCoordinator,
  wrapThreadUpdate,
} from "./threadOrchestration.ts";

const shell = (overrides: Partial<OrchestrationThreadShell>) =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    pullRequests: [],
    planProgress: null,
    ...overrides,
  }) as OrchestrationThreadShell;

const session = (status: string, lastError: string | null = null) =>
  ({ status, lastError }) as OrchestrationThreadShell["session"];
const openPullRequest = {
  number: 6,
  snapshot: { state: "open", isDraft: false },
} as unknown as OrchestrationThreadShell["pullRequests"][number];

describe("resolveChildThreadState", () => {
  it("puts a thread that waits on the user above everything else", () => {
    expect(
      resolveChildThreadState(shell({ session: session("running"), hasPendingApprovals: true })),
    ).toBe("waiting");
  });

  it("reads working, review and done from session, pull requests and turn", () => {
    expect(
      resolveChildThreadState(
        shell({
          session: session("running"),
          planProgress: { step: "Adding an alert", completedSteps: 4, totalSteps: 6 },
        }),
      ),
    ).toBe("working");
    expect(
      resolveChildThreadState(
        shell({ session: session("ready"), pullRequests: [openPullRequest] }),
      ),
    ).toBe("review");
    expect(resolveChildThreadState(shell({ session: session("ready") }))).toBe("done");
    expect(resolveChildThreadState(shell({ session: session("error", "boom") }))).toBe("failed");
  });

  it("keeps a thread working while its background tasks outlive the turn", () => {
    const idleWithSubagents = shell({ session: session("ready"), backgroundLiveness: "working" });
    expect(resolveChildThreadState(idleWithSubagents)).toBe("working");
    expect(describeChildThread(idleWithSubagents)).toBe("Waiting on its subagents");
    const idleWithMonitor = shell({
      session: session("ready"),
      pullRequests: [openPullRequest],
      backgroundLiveness: "monitoring",
    });
    expect(resolveChildThreadState(idleWithMonitor)).toBe("working");
    expect(describeChildThread(idleWithMonitor)).toBe("Waiting on background commands");
    expect(
      describeChildThread(shell({ session: session("running"), backgroundLiveness: "working" })),
    ).toBe("Working");
  });

  it("describes what the thread is doing or needs", () => {
    expect(
      describeChildThread(
        shell({
          session: session("running"),
          planProgress: { step: "Adding an alert", completedSteps: 4, totalSteps: 6 },
        }),
      ),
    ).toBe("Adding an alert");
    expect(describeChildThread(shell({ hasPendingUserInput: true }))).toBe(
      "Has a question for you",
    );
    expect(describeChildThread(shell({ pullRequests: [openPullRequest] }))).toBe("PR #6 open");
  });
});

describe("tagged thread messages", () => {
  it("round-trips a coordinator's message and a thread update", () => {
    const task = wrapFromCoordinator({
      coordinatorThreadId: "t-1",
      coordinatorTitle: 'Release "2.0"',
      text: "Trace the checkout retries.",
    });
    expect(parseTaggedThreadMessage(task)).toEqual({
      tag: "t3_from_coordinator",
      threadId: "t-1",
      title: 'Release "2.0"',
      state: null,
      detail: null,
      body: "Trace the checkout retries.",
    });

    const update = wrapThreadUpdate({
      threadId: "t-2",
      title: "Load test",
      state: "review",
      detail: "PR #6 open",
      text: "Line one\nLine two",
    });
    expect(parseTaggedThreadMessage(update)).toMatchObject({
      tag: "t3_thread_update",
      threadId: "t-2",
      state: "review",
      detail: "PR #6 open",
      body: "Line one\nLine two",
    });
  });

  it("leaves ordinary messages alone", () => {
    expect(parseTaggedThreadMessage("Please <t3_thread_update> look")).toBe(null);
    expect(parseThreadUpdates("Please <t3_thread_update> look")).toBe(null);
  });

  it("reads updates of several children that arrived as one turn", () => {
    const first = wrapThreadUpdate({
      threadId: "t-1",
      title: "API",
      state: "done",
      detail: "Finished",
      text: "Endpoint added.",
    });
    const second = wrapThreadUpdate({
      threadId: "t-2",
      title: "UI",
      state: "failed",
      detail: "Out of tokens",
      text: "(It gave no answer.)",
    });
    const bundle = `${first}\n\n${second}`;
    // A bundle is not one update whose body holds the next.
    expect(parseTaggedThreadMessage(bundle)).toBe(null);
    expect(parseThreadUpdates(bundle)?.map((update) => [update.threadId, update.body])).toEqual([
      ["t-1", "Endpoint added."],
      ["t-2", "(It gave no answer.)"],
    ]);
    expect(parseThreadUpdates(first)).toHaveLength(1);
    expect(parseThreadUpdates(`${bundle}\nAnd a note.`)).toBe(null);
    expect(plainTextOfThreadMessage(bundle)).toBe(
      "API · Done · Finished; UI · Failed · Out of tokens",
    );
    expect(readableThreadMessage(bundle)).toBe(
      "**API · Done · Finished**\n\nEndpoint added.\n\n**UI · Failed · Out of tokens**\n\n(It gave no answer.)",
    );
  });
});

describe("thread links", () => {
  it("round-trips a thread id", () => {
    expect(parseThreadLinkHref(threadLinkHref("abc-123"))).toBe("abc-123");
    expect(parseThreadLinkHref("https://example.com")).toBe(null);
  });
});
