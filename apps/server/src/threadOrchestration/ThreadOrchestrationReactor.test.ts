import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answersLatestPrompt,
  childBackgroundFor,
  childUpdateBody,
  childUpdateDetail,
  childUpdateFor,
  clampAnswer,
  coordinatorHasUpdate,
} from "./ThreadOrchestrationReactor.ts";
import { ThreadId } from "@t3tools/contracts";
import { wrapThreadUpdate } from "@t3tools/shared/threadOrchestration";

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

describe("childBackgroundFor", () => {
  const ended = shell({ ...settled, backgroundLiveness: "monitoring" });
  const background = (liveTaskTypes: ReadonlyArray<string | undefined>, stalled = false) =>
    childBackgroundFor({ child: ended, liveTaskTypes, stalled });

  it("tells watches from work that holds the child up", () => {
    expect(background(["monitor", "monitor_ws"])).toEqual({ kind: "watches", count: 2 });
    // A background shell is a build or a test run as often as a log tail.
    expect(background(["monitor", "local_bash"])).toEqual({ kind: "work", stalled: false });
    expect(background(["local_agent"], true)).toEqual({ kind: "work", stalled: true });
    expect(background([undefined])).toEqual({ kind: "work", stalled: false });
    expect(childBackgroundFor({ child: settled, liveTaskTypes: [], stalled: false })).toEqual({
      kind: "none",
    });
    // While the turn runs, the child works whatever runs beside it.
    expect(
      childBackgroundFor({
        child: shell({ ...running, backgroundLiveness: "monitoring" }),
        liveTaskTypes: ["monitor"],
        stalled: false,
      }),
    ).toEqual({ kind: "none" });
  });

  it("reports a child with only watches left as done, and says they run", () => {
    const watches = background(["monitor_ws"]);
    const update = childUpdateFor({
      child: ended,
      latestPromptId: null,
      latestAnswerId: "m1",
      requestActivityId: undefined,
      background: watches,
    });
    expect(update).toEqual({ key: "done:m1", state: "done" });
    expect(childUpdateDetail({ child: ended, background: watches })).toBe(
      "Finished; 1 watch still running",
    );
  });

  it("reports a child stuck on background work only once it stalled", () => {
    const working = shell({ ...settled, backgroundLiveness: "working" });
    const update = (stalled: boolean) =>
      childUpdateFor({
        child: working,
        latestPromptId: "u1",
        latestAnswerId: "m1",
        requestActivityId: undefined,
        background: { kind: "work", stalled },
      });
    expect(update(false)).toBe(null);
    expect(update(true)).toEqual({ key: "stalled:u1:m1", state: "working" });
    expect(childUpdateDetail({ child: working, background: { kind: "work", stalled: true } })).toBe(
      "Waiting on its subagents, no activity for 30 min",
    );
    expect(
      childUpdateBody({
        state: "working",
        latestAnswer: "Started the migration.",
        background: { kind: "work", stalled: true },
      }),
    ).toContain("You get another update when they finish");
  });
});

describe("clampAnswer", () => {
  it("keeps a short answer whole", () => {
    expect(clampAnswer("  Fixed it.  ")).toBe("Fixed it.");
  });

  it("cuts a long answer at its last paragraph or sentence that fits", () => {
    const paragraphs = `${"a".repeat(70)}.\n\n${"b".repeat(20)}. ${"c".repeat(40)}`;
    expect(clampAnswer(paragraphs, 100)).toBe(
      `${"a".repeat(70)}.\n… (64 more characters; read_thread returns all of it)`,
    );
    const sentences = `${"a".repeat(60)}. ${"b".repeat(20)}. ${"c".repeat(40)}`;
    expect(clampAnswer(sentences, 100).split("\n")[0]).toBe(
      `${"a".repeat(60)}. ${"b".repeat(20)}.`,
    );
    // No sentence end in reach: cut at a word.
    const words = Array.from({ length: 40 }, () => "word").join(" ");
    expect(clampAnswer(words, 22).split("\n")[0]).toBe("word word word word");
  });
});

describe("coordinatorHasUpdate", () => {
  it("finds an update inside a bundle of several children", () => {
    const block = (threadId: string) =>
      wrapThreadUpdate({
        threadId,
        title: threadId,
        state: "done",
        detail: "Finished",
        text: "ok",
      });
    const message = {
      role: "user" as const,
      text: `${block("child-a")}\n\n${block("child-b")}`,
      createdAt: "2026-09-23T10:05:00.000Z",
    };
    const has = (childId: string) =>
      coordinatorHasUpdate({
        coordinatorMessages: [message],
        childId: ThreadId.make(childId),
        state: "done",
        since: "2026-09-23T10:00:00.000Z",
      });
    expect(has("child-b")).toBe(true);
    expect(has("child-c")).toBe(false);
  });
});
