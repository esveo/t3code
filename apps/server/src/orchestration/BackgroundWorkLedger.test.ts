import { describe, expect, it } from "vite-plus/test";

import {
  buildBackgroundWorkContinuationPrompt,
  makeBackgroundTaskTracker,
  readBackgroundTasks,
} from "./BackgroundWorkLedger.ts";

const threadId = "thread-1";

const taskEvent = (
  type: "task.started" | "task.progress" | "task.updated" | "task.completed",
  payload: Record<string, unknown>,
) =>
  ({ type, threadId, payload }) as unknown as Parameters<
    ReturnType<typeof makeBackgroundTaskTracker>["record"]
  >[0];

describe("makeBackgroundTaskTracker", () => {
  it("reports the live task list only when it changes", () => {
    const tracker = makeBackgroundTaskTracker();

    expect(
      tracker.record(
        taskEvent("task.started", {
          taskId: "a1",
          taskType: "local_agent",
          description: "counter",
          role: "general-purpose",
        }),
      ),
    ).toEqual([
      {
        taskId: "a1",
        kind: "agent",
        taskType: "local_agent",
        title: "counter",
        role: "general-purpose",
      },
    ]);
    // Progress narrates the current step; it neither renames nor rewrites.
    expect(
      tracker.record(taskEvent("task.progress", { taskId: "a1", description: "Running tests" })),
    ).toBeUndefined();
    expect(
      tracker.record(taskEvent("task.completed", { taskId: "a1", status: "completed" })),
    ).toEqual([]);
  });

  it("lists a workflow once, with the run id that arrives after it started", () => {
    const tracker = makeBackgroundTaskTracker();
    tracker.record(
      taskEvent("task.started", {
        taskId: "w1",
        taskType: "local_workflow",
        description: "review",
      }),
    );
    tracker.record(
      taskEvent("task.progress", {
        taskId: "w1-member-0",
        description: "reviewing",
        status: "running",
        parentAgentId: "w1",
      }),
    );

    expect(
      tracker.record(taskEvent("task.updated", { taskId: "w1", runHandles: { runId: "wf_123" } })),
    ).toEqual([
      {
        taskId: "w1",
        kind: "workflow",
        taskType: "local_workflow",
        title: "review",
        runId: "wf_123",
      },
    ]);
  });

  it("ignores a subagent's own shells and tasks it never saw start", () => {
    const tracker = makeBackgroundTaskTracker();
    expect(
      tracker.record(
        taskEvent("task.started", { taskId: "b1", taskType: "local_bash", agentId: "a1" }),
      ),
    ).toBeUndefined();
    // A resumed session reports work that died with the previous process.
    expect(
      tracker.record(taskEvent("task.completed", { taskId: "old", status: "stopped" })),
    ).toBeUndefined();
  });

  it("empties the list when the session exits", () => {
    const tracker = makeBackgroundTaskTracker();
    tracker.record(taskEvent("task.started", { taskId: "m1", taskType: "monitor" }));

    expect(tracker.clear(threadId)).toEqual([]);
    expect(tracker.clear(threadId)).toBeUndefined();
  });
});

describe("buildBackgroundWorkContinuationPrompt", () => {
  it("tells the agent how to resume each kind of work", () => {
    const tasks = readBackgroundTasks({
      liveBackgroundTasks: [
        { taskId: "a1", kind: "agent", taskType: "local_agent", title: "counter" },
        { taskId: "w1", kind: "workflow", title: "review", runId: "wf_123" },
        { taskId: "m1", kind: "monitor", title: "watch CI" },
        { kind: "bogus" },
      ],
    });
    const prompt = buildBackgroundWorkContinuationPrompt(tasks);

    expect(tasks).toHaveLength(3);
    expect(prompt).toContain('SendMessage to "a1"');
    expect(prompt).toContain('resumeFromRunId "wf_123"');
    expect(prompt).toContain('monitor "watch CI": start it again');
  });
});
