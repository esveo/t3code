import { AGENT_TIME_CATEGORIES, type AgentTimeCategory } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  BACKGROUND_WAIT_CAP_MS,
  CATEGORY_COUNT,
  IDLE_GAP_CAP_MS,
  attributeThread,
  backgroundCommandLabel,
  type AgentTimeItem,
  type AgentTimeThread,
} from "./agentTimeAttribution.ts";
import { dayEdges, zonedDayStartMs } from "./agentTimeBuckets.ts";

const S = 1000;
const MIN = 60 * S;

/** Seconds per category for each bucket, without the zero entries. */
function attribute(thread: AgentTimeThread, edges: number[]) {
  const totals = new Float64Array((edges.length - 1) * CATEGORY_COUNT);
  attributeThread(thread, edges, totals);
  return Array.from({ length: edges.length - 1 }, (_, bucket) => {
    const row: Partial<Record<AgentTimeCategory, number>> = {};
    AGENT_TIME_CATEGORIES.forEach((category, index) => {
      const seconds = totals[bucket * CATEGORY_COUNT + index]!;
      if (seconds > 0) row[category] = Math.round(seconds * 1000) / 1000;
    });
    return row;
  });
}

const command = (startMs: number, endMs: number, input: string, output = ""): AgentTimeItem => ({
  type: "command_execution",
  startMs,
  endMs,
  command: input,
  outputHead: output,
});

describe("attributeThread", () => {
  it("adds up to the run's wall clock: thinking, tools, and model output between them", () => {
    const thread: AgentTimeThread = {
      runs: [{ startMs: 0, endMs: 100 * S }],
      items: [
        { type: "reasoning", startMs: 0, endMs: 10 * S },
        command(20 * S, 50 * S, "npx vitest run"),
        { type: "assistant_message", startMs: 90 * S, endMs: 90 * S },
      ],
    };
    expect(attribute(thread, [0, 1000 * S])).toEqual([
      { modelThinking: 10, modelOutput: 60, tests: 30 },
    ]);
  });

  it("splits parallel tool calls' overlap so the sum never exceeds the wall clock", () => {
    const thread: AgentTimeThread = {
      runs: [{ startMs: 0, endMs: 40 * S }],
      items: [command(0, 40 * S, "npx tsc --noEmit"), command(20 * S, 40 * S, "git status")],
    };
    expect(attribute(thread, [0, 40 * S])).toEqual([{ build: 30, gitCi: 10 }]);
  });

  it("splits intervals at bucket edges", () => {
    const thread: AgentTimeThread = {
      runs: [{ startMs: 0, endMs: 120 * MIN }],
      items: [command(30 * MIN, 90 * MIN, "pytest")],
    };
    expect(attribute(thread, [0, 60 * MIN, 120 * MIN])).toEqual([
      { modelOutput: 1800, tests: 1800 },
      { modelOutput: 1800, tests: 1800 },
    ]);
  });

  it("counts short pauses between runs as idle and drops long ones", () => {
    const thread: AgentTimeThread = {
      runs: [
        { startMs: 0, endMs: 10 * S },
        { startMs: 70 * S, endMs: 80 * S },
        { startMs: 80 * S + IDLE_GAP_CAP_MS + S, endMs: 90 * S + IDLE_GAP_CAP_MS + S },
      ],
      items: [],
    };
    expect(attribute(thread, [0, 2 * IDLE_GAP_CAP_MS])).toEqual([{ modelOutput: 30, idle: 60 }]);
  });

  it("puts subagent waits below the parent's own work and above model output", () => {
    const thread: AgentTimeThread = {
      runs: [{ startMs: 0, endMs: 100 * S }],
      items: [
        { type: "subagent", startMs: 0, endMs: 100 * S },
        { type: "dynamic_tool", toolName: "Read", startMs: 40 * S, endMs: 50 * S },
      ],
    };
    expect(attribute(thread, [0, 100 * S])).toEqual([{ files: 10, children: 90 }]);
  });

  it("charges the wait for a background command to the command, until its notification", () => {
    const input = "cd /repo && npx vitest run --reporter dot";
    const thread: AgentTimeThread = {
      runs: [
        { startMs: 0, endMs: 10 * S },
        // The completion wakes the agent with a new run.
        { startMs: 300 * S, endMs: 310 * S },
      ],
      items: [
        command(5 * S, 5 * S, input, "Command running in background with ID: b1. Output is"),
        {
          type: "notification",
          startMs: 300 * S,
          endMs: 300 * S,
          notificationKind: "background_command",
          notificationOutcome: "completed",
          notificationSummary: `Command "${input}" finished`,
        },
      ],
    };
    // 0-5 s and 300-310 s are model output; 5-300 s waits on the tests.
    expect(attribute(thread, [0, 400 * S])).toEqual([{ modelOutput: 15, tests: 295 }]);
  });

  it("matches a long command by its truncated label and ignores stopped ones", () => {
    const input = `docker exec app sh -c "${"x".repeat(100)}"`;
    const label = backgroundCommandLabel(input)!;
    expect(label.endsWith("…")).toBe(true);
    const notification = (atMs: number, outcome: string): AgentTimeItem => ({
      type: "notification",
      startMs: atMs,
      endMs: atMs,
      notificationKind: "background_command",
      notificationOutcome: outcome,
      notificationSummary: `Command "${label}" ${outcome === "cancelled" ? "was stopped" : "finished"}`,
    });
    const started = "Command running in background with ID: b2. Output";
    const completed: AgentTimeThread = {
      runs: [],
      items: [command(0, 0, input, started), notification(60 * S, "completed")],
    };
    expect(attribute(completed, [0, 100 * S])).toEqual([{ jobs: 60 }]);
    const stopped: AgentTimeThread = {
      runs: [],
      items: [command(0, 0, input, started), notification(60 * S, "cancelled")],
    };
    expect(attribute(stopped, [0, 100 * S])).toEqual([{}]);
  });

  it("pairs a report quoting the Bash description with the latest waiting command", () => {
    const report = (atMs: number, label: string): AgentTimeItem => ({
      type: "notification",
      startMs: atMs,
      endMs: atMs,
      notificationKind: "background_command",
      notificationOutcome: "completed",
      notificationSummary: `Command "${label}" finished`,
    });
    const thread: AgentTimeThread = {
      runs: [],
      items: [
        // A dev server that never reports.
        command(0, 0, "npx vite dev", "Command running in background with ID: b4."),
        command(10 * S, 10 * S, "gh run watch 123", "Command running in background with ID: b5."),
        report(70 * S, "Wait for CI run to finish"),
      ],
    };
    expect(attribute(thread, [0, 100 * S])).toEqual([{ gitCi: 60 }]);
  });

  it("does not wait on a background command that runs longer than the cap", () => {
    const input = "npx vite dev";
    const thread: AgentTimeThread = {
      runs: [],
      items: [
        command(0, 0, input, "Command running in background with ID: b3."),
        {
          type: "notification",
          startMs: BACKGROUND_WAIT_CAP_MS + S,
          endMs: BACKGROUND_WAIT_CAP_MS + S,
          notificationKind: "background_command",
          notificationOutcome: "completed",
          notificationSummary: `Command "${input}" finished`,
        },
      ],
    };
    expect(attribute(thread, [0, 2 * BACKGROUND_WAIT_CAP_MS])).toEqual([{}]);
  });

  it("charges blocking on a background command's output to that command", () => {
    const thread: AgentTimeThread = {
      runs: [{ startMs: 0, endMs: 60 * S }],
      items: [
        command(0, 0, "gh run watch 9", "Command running in background with ID: b4."),
        { type: "dynamic_tool", toolName: "TaskOutput", taskId: "b4", startMs: 0, endMs: 60 * S },
      ],
    };
    expect(attribute(thread, [0, 60 * S])).toEqual([{ gitCi: 60 }]);
  });
});

describe("dayEdges", () => {
  it("starts days at local midnight across a DST change", () => {
    const edges = dayEdges(["2026-10-24", "2026-10-25"], "Europe/Berlin");
    expect(edges[0]).toBe(Date.parse("2026-10-23T22:00:00Z"));
    expect(edges[1]).toBe(Date.parse("2026-10-24T22:00:00Z"));
    // The 25th has 25 hours in Berlin.
    expect(edges[2]).toBe(Date.parse("2026-10-25T23:00:00Z"));
    expect(zonedDayStartMs("2026-10-16", "UTC")).toBe(Date.parse("2026-10-16T00:00:00Z"));
  });
});
