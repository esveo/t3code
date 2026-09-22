import { describe, expect, it } from "vite-plus/test";
import { buildSidebarProjectRunPlan } from "./sidebarProjectRuns.logic";

interface TestThread {
  readonly key: string;
  readonly project: string | null;
  readonly running?: boolean;
  readonly waiting?: boolean;
}

function plan(
  threads: readonly TestThread[],
  options: { collapsed?: readonly string[]; open?: string } = {},
) {
  return buildSidebarProjectRunPlan({
    threads,
    threadKeyOf: (thread) => thread.key,
    projectKeyOf: (thread) => thread.project,
    isCollapsed: (projectKey) => (options.collapsed ?? []).includes(projectKey),
    isRunning: (thread) => thread.running === true,
    needsAttention: (thread) => thread.waiting === true,
    isProtected: (thread) => thread.key === options.open,
  });
}

const thread = (key: string, project: string | null, running = false): TestThread => ({
  key,
  project,
  running,
});

const waitingThread = (key: string, project: string): TestThread => ({
  key,
  project,
  waiting: true,
});

describe("buildSidebarProjectRunPlan", () => {
  it("gathers a project's threads at the position of its first one", () => {
    const result = plan([
      thread("a1", "alpha"),
      thread("b1", "beta"),
      thread("a2", "alpha"),
      thread("b2", "beta"),
      thread("a3", "alpha"),
    ]);

    expect(result.threads.map((entry) => entry.key)).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect([...result.headersBeforeThreadKey.keys()]).toEqual(["a1", "b1"]);
    expect(result.headersBeforeThreadKey.get("a1")).toEqual([
      { projectKey: "alpha", threadCount: 3, runningCount: 0, attentionCount: 0, collapsed: false },
    ]);
    expect(result.placementByThreadKey.get("a1")).toBe("first");
    expect(result.placementByThreadKey.get("a2")).toBe("middle");
    expect(result.placementByThreadKey.get("a3")).toBe("last");
    expect(result.placementByThreadKey.get("b2")).toBe("last");
  });

  it("leaves a list alone when no project has a second thread", () => {
    const threads = [thread("a1", "alpha"), thread("b1", "beta"), thread("c1", "gamma")];
    const result = plan(threads);

    expect(result.threads).toBe(threads);
    expect(result.headersBeforeThreadKey.size).toBe(0);
    expect(result.placementByThreadKey.size).toBe(0);
  });

  it("leaves a single-project list alone", () => {
    const threads = [thread("a1", "alpha"), thread("a2", "alpha")];
    expect(plan(threads).threads).toBe(threads);
  });

  it("keeps a thread whose project has not loaded in its own run", () => {
    const result = plan([
      thread("a1", "alpha"),
      thread("x1", null),
      thread("a2", "alpha"),
      thread("x2", null),
    ]);

    expect(result.threads.map((entry) => entry.key)).toEqual(["a1", "a2", "x1", "x2"]);
    expect(result.placementByThreadKey.get("x1")).toBe("only");
    expect(result.placementByThreadKey.get("x2")).toBe("only");
  });

  it("drops a collapsed run's rows but keeps its header and its count", () => {
    const result = plan(
      [
        thread("a1", "alpha"),
        thread("a2", "alpha", true),
        thread("b1", "beta"),
        thread("b2", "beta"),
      ],
      { collapsed: ["alpha"] },
    );

    expect(result.threads.map((entry) => entry.key)).toEqual(["b1", "b2"]);
    expect(result.headersBeforeThreadKey.get("b1")).toEqual([
      { projectKey: "alpha", threadCount: 2, runningCount: 1, attentionCount: 0, collapsed: true },
      { projectKey: "beta", threadCount: 2, runningCount: 0, attentionCount: 0, collapsed: false },
    ]);
    expect(result.trailingHeaders).toEqual([]);
  });

  it("keeps the open thread visible inside a collapsed run", () => {
    const result = plan(
      [thread("a1", "alpha"), thread("a2", "alpha"), thread("b1", "beta"), thread("b2", "beta")],
      { collapsed: ["alpha"], open: "a2" },
    );

    expect(result.threads.map((entry) => entry.key)).toEqual(["a2", "b1", "b2"]);
    expect(result.placementByThreadKey.get("a2")).toBe("only");
    expect(result.headersBeforeThreadKey.get("a2")).toEqual([
      { projectKey: "alpha", threadCount: 2, runningCount: 0, attentionCount: 0, collapsed: true },
    ]);
  });

  it("leads the section with the run that waits on the user", () => {
    const result = plan([
      thread("a1", "alpha"),
      thread("a2", "alpha"),
      thread("b1", "beta"),
      waitingThread("b2", "beta"),
    ]);

    expect(result.threads.map((entry) => entry.key)).toEqual(["b1", "b2", "a1", "a2"]);
    expect(result.runs.map((run) => run.projectKey)).toEqual(["beta", "alpha"]);
    expect(result.runs[0]?.attentionCount).toBe(1);
  });

  it("shows a folded run's waiting threads and hides the rest", () => {
    const result = plan(
      [
        thread("a1", "alpha"),
        thread("a2", "alpha"),
        thread("b1", "beta"),
        waitingThread("b2", "beta"),
      ],
      { collapsed: ["alpha", "beta"] },
    );

    // beta leads because it waits, and shows only the waiting thread.
    expect(result.threads.map((entry) => entry.key)).toEqual(["b2"]);
    expect(result.headersBeforeThreadKey.get("b2")).toEqual([
      { projectKey: "beta", threadCount: 2, runningCount: 0, attentionCount: 1, collapsed: true },
    ]);
    expect(result.trailingHeaders).toEqual([
      { projectKey: "alpha", threadCount: 2, runningCount: 0, attentionCount: 0, collapsed: true },
    ]);
  });

  it("trails the headers of runs collapsed at the end of the list", () => {
    const result = plan(
      [thread("a1", "alpha"), thread("a2", "alpha"), thread("b1", "beta"), thread("b2", "beta")],
      { collapsed: ["beta"] },
    );

    expect(result.threads.map((entry) => entry.key)).toEqual(["a1", "a2"]);
    expect(result.trailingHeaders).toEqual([
      { projectKey: "beta", threadCount: 2, runningCount: 0, attentionCount: 0, collapsed: true },
    ]);
  });
});
