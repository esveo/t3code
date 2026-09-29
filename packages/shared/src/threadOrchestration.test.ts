import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  type ChildThreadShell,
  coordinatorThreadIdOf,
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

const shell = (overrides: Partial<ChildThreadShell>) =>
  ({
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    lastError: null,
    pullRequests: [],
    pendingBackgroundTasks: [],
    ...overrides,
  }) as ChildThreadShell;

const openPullRequest = {
  number: 6,
  snapshot: { state: "open", isDraft: false },
} as unknown as NonNullable<ChildThreadShell["pullRequests"]>[number];
const pendingRequest = (kind: string) =>
  ({ id: "request-1", kind }) as unknown as NonNullable<ChildThreadShell["pendingRuntimeRequest"]>;
const backgroundTask = (kind: string) =>
  ({ taskId: "task-1", kind, description: "tests" }) as unknown as NonNullable<
    ChildThreadShell["pendingBackgroundTasks"]
  >[number];

describe("resolveChildThreadState", () => {
  it("puts a thread that waits on the user above everything else", () => {
    expect(
      resolveChildThreadState(
        shell({ status: "running", pendingRuntimeRequest: pendingRequest("command_execution") }),
      ),
    ).toBe("waiting");
  });

  it("reads working, review, stopped, failed and done from the shell", () => {
    expect(resolveChildThreadState(shell({ status: "running" }))).toBe("working");
    expect(resolveChildThreadState(shell({ status: "preparing" }))).toBe("working");
    expect(resolveChildThreadState(shell({ pullRequests: [openPullRequest] }))).toBe("review");
    expect(resolveChildThreadState(shell({ status: "completed" }))).toBe("done");
    expect(resolveChildThreadState(shell({ status: "interrupted" }))).toBe("stopped");
    expect(resolveChildThreadState(shell({ status: "failed", lastError: "boom" }))).toBe("failed");
  });

  it("keeps a thread working while its background tasks outlive the turn", () => {
    const idleWithSubagents = shell({
      status: "completed",
      pendingBackgroundTasks: [backgroundTask("subagent")],
    });
    expect(resolveChildThreadState(idleWithSubagents)).toBe("working");
    expect(describeChildThread(idleWithSubagents)).toBe("Waiting on its subagents");
    const idleWithMonitor = shell({
      status: "completed",
      pullRequests: [openPullRequest],
      pendingBackgroundTasks: [backgroundTask("monitor")],
    });
    expect(resolveChildThreadState(idleWithMonitor)).toBe("working");
    expect(describeChildThread(idleWithMonitor)).toBe("Waiting on background commands");
  });

  it("describes what the thread is doing or needs", () => {
    expect(describeChildThread(shell({ status: "preparing" }))).toBe("Setting up");
    expect(
      describeChildThread(shell({ pendingRuntimeRequest: pendingRequest("user_input") })),
    ).toBe("Has a question for you");
    expect(describeChildThread(shell({ status: "failed", lastError: "boom\ntrace" }))).toBe("boom");
    expect(describeChildThread(shell({ pullRequests: [openPullRequest] }))).toBe("PR #6 open");
  });
});

describe("coordinatorThreadIdOf", () => {
  const coordinator = ThreadId.make("coordinator");
  const other = ThreadId.make("other");
  const thread = (
    relationshipToParent: "subagent" | "fork" | null,
    creationSource: "mcp" | "provider" | "web",
  ) => ({
    id: ThreadId.make("child"),
    creationSource,
    lineage: {
      parentThreadId: relationshipToParent === null ? null : coordinator,
      relationshipToParent,
      rootThreadId: coordinator,
    },
  });

  it("puts a T3-owned delegated child under the thread that started it", () => {
    expect(coordinatorThreadIdOf(thread("subagent", "mcp") as never, new Map())).toBe(coordinator);
  });

  it("leaves provider subagents, forks and top-level threads alone", () => {
    expect(coordinatorThreadIdOf(thread("subagent", "provider") as never, new Map())).toBe(null);
    expect(coordinatorThreadIdOf(thread("fork", "web") as never, new Map())).toBe(null);
    expect(coordinatorThreadIdOf(thread(null, "web") as never, new Map())).toBe(null);
  });

  it("follows a moved, adopted or released thread", () => {
    const child = ThreadId.make("child");
    expect(
      coordinatorThreadIdOf(thread("subagent", "mcp") as never, new Map([[child, other]])),
    ).toBe(other);
    expect(
      coordinatorThreadIdOf(thread("subagent", "mcp") as never, new Map([[child, null]])),
    ).toBe(null);
    expect(coordinatorThreadIdOf(thread(null, "web") as never, new Map([[child, other]]))).toBe(
      other,
    );
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
      answerId: null,
      body: "Trace the checkout retries.",
    });

    const update = wrapThreadUpdate({
      threadId: "t-2",
      title: "Load test",
      state: "review",
      detail: "PR #6 open",
      answerId: "msg-9",
      text: "Line one\nLine two",
    });
    expect(parseTaggedThreadMessage(update)).toMatchObject({
      tag: "t3_thread_update",
      threadId: "t-2",
      state: "review",
      detail: "PR #6 open",
      answerId: "msg-9",
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
