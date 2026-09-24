import {
  classifyTaskAgentKind,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyStageVisibility,
  deriveStageModel,
  deriveStageRecap,
  MAIN_AGENT_ID,
  stageElapsedMs,
  stageInitials,
  stageIsStuck,
  stageStationTimes,
  stationForToolName,
} from "./agentStage.logic";

let nextId = 0;

function activity(overrides: {
  kind: string;
  createdAt?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  const rawPayload = overrides.payload ?? {};
  const payload =
    overrides.kind.startsWith("task.") && !("agentKind" in rawPayload)
      ? {
          ...rawPayload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof rawPayload.taskType === "string" ? rawPayload.taskType : undefined,
            agentId: typeof rawPayload.agentId === "string" ? rawPayload.agentId : undefined,
          }),
        }
      : rawPayload;
  nextId += 1;
  return {
    id: EventId.make(`activity-${nextId}`),
    createdAt: overrides.createdAt ?? `2026-09-21T10:00:${String(nextId).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: TurnId.make(overrides.turnId ?? "turn-1"),
    sequence: nextId,
  };
}

const session = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "claude",
  runtimeMode: "full-access",
  activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
  lastError: null,
  updatedAt: "2026-09-21T10:00:00.000Z",
});

const latestTurn = (state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn => ({
  turnId: TurnId.make("turn-1"),
  state,
  requestedAt: "2026-09-21T09:59:59.000Z",
  startedAt: "2026-09-21T10:00:00.000Z",
  completedAt: state === "running" ? null : "2026-09-21T10:01:00.000Z",
  assistantMessageId: null,
});

const message = (
  role: OrchestrationMessage["role"],
  text: string,
  streaming: boolean,
): OrchestrationMessage => ({
  id: MessageId.make(`message-${role}-${text.length}`),
  role,
  text,
  turnId: TurnId.make("turn-1"),
  streaming,
  createdAt: "2026-09-21T10:00:01.000Z",
  updatedAt: "2026-09-21T10:00:01.000Z",
});

const runningTool = (payload: Record<string, unknown>) =>
  activity({ kind: "tool.updated", payload: { status: "inProgress", ...payload } });

describe("deriveStageModel", () => {
  it("rests the main agent at idle when the thread has no turn", () => {
    const model = deriveStageModel({
      activities: [],
      messages: [],
      session: null,
      latestTurn: null,
    });
    expect(model.running).toBe(false);
    expect(model.agents).toEqual([
      expect.objectContaining({
        id: MAIN_AGENT_ID,
        station: "idle",
        live: false,
        headline: "Waiting for a prompt",
      }),
    ]);
  });

  it("puts a running command at the terminal with the command as detail", () => {
    const model = deriveStageModel({
      activities: [
        runningTool({
          itemType: "command_execution",
          toolCallId: "call-1",
          title: "Run command",
          data: { command: "npm test" },
        }),
      ],
      messages: [message("reasoning", "Let me run the tests.", false)],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("command");
    expect(main.thought).toBe("Let me run the tests.");
    expect(main.live).toBe(true);
    expect(main.headline).toMatch(/^Running/);
    expect(main.detail).toBe("npm test");
  });

  it("moves to thinking once the tool completes and reasoning streams", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "tool.completed",
          payload: { itemType: "file_change", status: "completed", toolCallId: "call-2" },
        }),
      ],
      messages: [message("reasoning", "Now I should check the tests.", true)],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("thinking");
    expect(main.detail).toBe("Now I should check the tests.");
    expect(main.thought).toBe("Now I should check the tests.");
    expect(main.recent).toHaveLength(1);
  });

  it("answers while the assistant message streams", () => {
    const model = deriveStageModel({
      activities: [],
      messages: [message("assistant", "Here is what I found.", true)],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents[0]!.station).toBe("writing");
  });

  it("waits for the user while an approval is open", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "approval.requested",
          tone: "approval",
          payload: { requestId: "req-1", requestType: "command", detail: "rm -rf build" },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents[0]).toEqual(
      expect.objectContaining({ station: "waiting", detail: "rm -rf build" }),
    );
  });

  it("shows subagents at their own tool while the main agent waits on them", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "task.started",
          payload: {
            taskId: "task-1",
            taskType: "local_agent",
            title: "Find the login bug",
            role: "Explore",
          },
        }),
        activity({
          kind: "tool.started",
          payload: {
            itemType: "dynamic_tool_call",
            title: "Read",
            detail: "src/auth/login.ts",
            agentId: "task-1",
            toolCallId: "call-3",
          },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents.map((agent) => agent.id)).toEqual([MAIN_AGENT_ID, "task-1"]);
    expect(model.agents[0]).toEqual(
      expect.objectContaining({ station: "delegate", headline: "Waiting for 1 subagent" }),
    );
    expect(model.agents[1]).toEqual(
      expect.objectContaining({
        kind: "subagent",
        label: "Find the login bug",
        role: "Explore",
        station: "read",
        live: true,
        headline: "Read",
        detail: "src/auth/login.ts",
      }),
    );
  });

  it("settles everyone at idle after the turn", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "task.started",
          payload: { taskId: "task-1", taskType: "local_agent", title: "Audit" },
        }),
        activity({
          kind: "task.completed",
          payload: { taskId: "task-1", status: "completed", summary: "All good" },
        }),
      ],
      messages: [message("assistant", "Done.", false)],
      session: session("ready"),
      latestTurn: latestTurn("completed"),
    });
    expect(model.running).toBe(false);
    expect(model.agents.map((agent) => [agent.station, agent.live, agent.headline])).toEqual([
      ["idle", false, "Done"],
      ["idle", false, "Done"],
    ]);
  });

  it("keeps background subagents working after the turn, until the session dies", () => {
    const activities = [
      activity({
        kind: "task.started",
        payload: { taskId: "task-1", taskType: "local_agent", title: "Audit" },
      }),
      activity({
        kind: "tool.started",
        payload: { title: "Bash", agentId: "task-1", toolCallId: "call-1" },
      }),
    ];
    const afterTurn = deriveStageModel({
      activities,
      messages: [message("assistant", "Started it.", false)],
      session: session("ready"),
      latestTurn: latestTurn("completed"),
    });
    expect(afterTurn.running).toBe(true);
    expect(afterTurn.agents.map((agent) => [agent.station, agent.live, agent.headline])).toEqual([
      ["delegate", true, "Waiting for 1 subagent"],
      ["command", true, "Bash"],
    ]);

    const dead = deriveStageModel({
      activities,
      messages: [],
      session: session("stopped"),
      latestTurn: latestTurn("completed"),
    });
    expect(dead.running).toBe(false);
    expect(dead.agents.map((agent) => [agent.station, agent.live])).toEqual([
      ["idle", false],
      ["idle", false],
    ]);
  });
});

const at = (seconds: string) => `2026-09-21T10:0${seconds}.000Z`;
const clock = (seconds: string) => Date.parse(at(seconds));

const readRow = (index: number) =>
  activity({
    kind: "tool.completed",
    createdAt: at(`0:${String(10 + index).padStart(2, "0")}`),
    summary: "Read src/auth/login.ts",
    payload: {
      itemType: "file_read",
      status: "completed",
      toolCallId: `read-${index}`,
      title: "Read",
      detail: "src/auth/login.ts",
    },
  });

describe("stage attention", () => {
  it("offers an open approval with the request behind it", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "approval.requested",
          tone: "approval",
          createdAt: at("0:20"),
          payload: {
            requestId: "req-1",
            requestKind: "command",
            detail: "rm -rf build",
            options: [
              { decision: "decline", label: "Decline" },
              { decision: "accept", label: "Approve" },
            ],
          },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.attention).toEqual([
      expect.objectContaining({
        kind: "approval",
        agentId: MAIN_AGENT_ID,
        title: "Approve a command",
        detail: "rm -rf build",
      }),
    ]);
    expect(model.attention[0]!.approval?.options).toHaveLength(2);
  });

  it("takes questions and waiting subagents too, oldest first", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "user-input.requested",
          createdAt: at("0:30"),
          payload: {
            requestId: "req-2",
            questions: [
              {
                id: "q1",
                header: "Scope",
                question: "Which package should I touch?",
                options: [{ label: "web" }, { label: "server" }],
              },
            ],
          },
        }),
        activity({
          kind: "approval.requested",
          tone: "approval",
          createdAt: at("0:10"),
          payload: { requestId: "req-3", requestKind: "file-change", detail: "src/app.ts" },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.attention.map((item) => item.kind)).toEqual(["approval", "question"]);
    expect(model.attention[1]!.title).toBe("Which package should I touch?");
    expect(model.attention[1]!.approval).toBeNull();
  });

  it("stays empty once the request is resolved", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "approval.requested",
          tone: "approval",
          payload: { requestId: "req-4", requestKind: "command", detail: "npm test" },
        }),
        activity({ kind: "approval.resolved", payload: { requestId: "req-4" } }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.attention).toEqual([]);
  });
});

describe("stage station time", () => {
  it("charges a finished step to its station", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "tool.updated",
          createdAt: at("0:10"),
          payload: {
            status: "inProgress",
            itemType: "command_execution",
            toolCallId: "call-1",
            title: "Run command",
            data: { command: "npm test" },
          },
        }),
        activity({
          kind: "tool.completed",
          createdAt: at("0:40"),
          payload: {
            status: "completed",
            itemType: "command_execution",
            toolCallId: "call-1",
            title: "Run command",
            data: { command: "npm test" },
          },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const main = model.agents[0]!;
    // The turn began at 10:00:00, so the whole run up to the completion counts.
    expect(main.stationTimes).toEqual([{ station: "command", ms: 40_000 }]);
  });

  it("keeps the running step out of the totals and adds it back at render", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "tool.updated",
          createdAt: at("0:10"),
          payload: {
            status: "inProgress",
            itemType: "command_execution",
            toolCallId: "call-1",
            title: "Run command",
            data: { command: "npm test" },
          },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("command");
    expect(main.since).toBe(at("0:10"));
    expect(main.stationTimes).toEqual([{ station: "thinking", ms: 10_000 }]);
    expect(stageElapsedMs(main, clock("0:40"))).toBe(30_000);
    expect(stageStationTimes(main, clock("0:40"))).toEqual([
      { station: "command", ms: 30_000 },
      { station: "thinking", ms: 10_000 },
    ]);
  });

  it("calls a station stuck once its own patience runs out", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "approval.requested",
          tone: "approval",
          createdAt: at("0:10"),
          payload: { requestId: "req-5", requestKind: "command", detail: "npm test" },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("waiting");
    expect(stageIsStuck(main, clock("1:00"))).toBe(false);
    expect(stageIsStuck(main, clock("3:00"))).toBe(true);
  });

  it("rests without a clock once the turn is over", () => {
    const model = deriveStageModel({
      activities: [],
      messages: [message("assistant", "Done.", false)],
      session: session("ready"),
      latestTurn: latestTurn("completed"),
    });
    const main = model.agents[0]!;
    expect(main.since).toBeNull();
    expect(stageElapsedMs(main, clock("9:00"))).toBeNull();
    expect(stageIsStuck(main, clock("9:00"))).toBe(false);
  });
});

describe("stage alerts", () => {
  it("calls out a step the agent keeps repeating", () => {
    const model = deriveStageModel({
      activities: [readRow(0), readRow(1), readRow(2)],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents[0]!.alerts).toEqual([
      expect.objectContaining({ kind: "repeating", text: expect.stringMatching(/3 times over$/) }),
    ]);
  });

  it("calls out a run of failing steps", () => {
    const failing = (index: number) =>
      activity({
        kind: "tool.completed",
        tone: "error",
        createdAt: at(`0:${String(20 + index).padStart(2, "0")}`),
        summary: `Failed step ${index}`,
        payload: {
          itemType: "command_execution",
          status: "failed",
          toolCallId: `fail-${index}`,
          title: "Run command",
          data: { command: `npm run check-${index}` },
        },
      });
    const model = deriveStageModel({
      activities: [failing(0), failing(1)],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents[0]!.alerts).toContainEqual(
      expect.objectContaining({ kind: "failing", text: "2 of the last 2 steps failed" }),
    );
  });

  it("says a subagent failed", () => {
    const model = deriveStageModel({
      activities: [
        activity({
          kind: "task.started",
          payload: { taskId: "task-1", taskType: "local_agent", title: "Audit" },
        }),
        activity({
          kind: "task.completed",
          summary: "Ran out of context",
          payload: { taskId: "task-1", status: "failed", summary: "Ran out of context" },
        }),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const subagent = model.agents[1]!;
    expect(subagent.headline).toBe("Failed");
    expect(subagent.alerts).toEqual([
      expect.objectContaining({ kind: "failed", text: "Ran out of context" }),
    ]);
  });
});

const subagentStep = (index: number, status: "completed" | "failed", detail = "src/a.ts") =>
  activity({
    kind: "tool.completed",
    createdAt: at(`0:${String(30 + index).padStart(2, "0")}`),
    payload: {
      itemType: "dynamic_tool_call",
      status,
      title: "Read",
      detail,
      agentId: "task-1",
      toolCallId: `sub-${index}`,
    },
  });

const spawn = () =>
  activity({
    kind: "task.started",
    createdAt: at("0:29"),
    payload: { taskId: "task-1", taskType: "local_agent", title: "Audit" },
  });

describe("subagent alerts", () => {
  it("calls out a step a subagent keeps repeating", () => {
    const model = deriveStageModel({
      activities: [
        spawn(),
        subagentStep(0, "completed"),
        subagentStep(1, "completed"),
        subagentStep(2, "completed"),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents[0]!.alerts).toEqual([]);
    expect(model.agents[1]!.alerts).toEqual([
      expect.objectContaining({ kind: "repeating", text: "Read src/a.ts 3 times over" }),
    ]);
  });

  it("calls out a subagent's failing steps and counts them for the recap", () => {
    const model = deriveStageModel({
      activities: [
        spawn(),
        subagentStep(0, "failed", "a"),
        subagentStep(1, "failed", "b"),
        subagentStep(2, "completed", "c"),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const subagent = model.agents[1]!;
    expect(subagent.alerts).toEqual([
      expect.objectContaining({ kind: "failing", text: "2 of the last 3 steps failed" }),
    ]);
    expect(subagent.steps).toBe(3);
    expect(subagent.failedSteps).toBe(2);
  });

  it("reads repeats from progress lines when no tool rows are attributed", () => {
    // Identical consecutive lines collapse in the fold; a loop shows as alternation.
    const progress = (index: number, summary: string) =>
      activity({
        kind: "task.progress",
        createdAt: at(`0:${String(30 + index).padStart(2, "0")}`),
        summary,
        payload: { taskId: "task-1", summary },
      });
    const model = deriveStageModel({
      activities: [
        spawn(),
        progress(0, "Running the tests"),
        progress(1, "Editing"),
        progress(2, "Running the tests"),
        progress(3, "Editing"),
        progress(4, "Running the tests"),
      ],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(model.agents[1]!.alerts).toEqual([
      expect.objectContaining({ kind: "repeating", text: "Running the tests 3 times over" }),
    ]);
  });
});

describe("stage recap", () => {
  it("says nothing while the agent still works", () => {
    const model = deriveStageModel({
      activities: [readRow(0)],
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    expect(deriveStageRecap(model.agents[0]!)).toBeNull();
  });

  it("sums the settled turn: steps, failures, and the answer at the end", () => {
    // Rows order by sequence, so the read is created before the failure.
    const read = readRow(0);
    const failed = activity({
      kind: "tool.completed",
      tone: "error",
      createdAt: at("0:20"),
      summary: "Failed step",
      payload: {
        itemType: "command_execution",
        status: "failed",
        toolCallId: "fail-1",
        title: "Run command",
        data: { command: "npm test" },
      },
    });
    const model = deriveStageModel({
      activities: [read, failed],
      messages: [message("assistant", "Done.", false)],
      session: session("ready"),
      latestTurn: latestTurn("completed"),
    });
    const recap = deriveStageRecap(model.agents[0]!);
    expect(recap).toEqual({
      totalMs: 60_000,
      steps: 2,
      failedSteps: 1,
      stationTimes: [
        { station: "writing", ms: 40_000 },
        { station: "read", ms: 10_000 },
        { station: "command", ms: 10_000 },
      ],
    });
  });

  it("charges the tail of a failed turn to thinking, not to the answer", () => {
    const model = deriveStageModel({
      activities: [readRow(0)],
      messages: [],
      session: session("error"),
      latestTurn: latestTurn("error"),
    });
    expect(deriveStageRecap(model.agents[0]!)?.stationTimes).toEqual([
      { station: "thinking", ms: 50_000 },
      { station: "read", ms: 10_000 },
    ]);
  });

  it("stays quiet for a thread that never did anything", () => {
    const model = deriveStageModel({
      activities: [],
      messages: [],
      session: null,
      latestTurn: null,
    });
    expect(deriveStageRecap(model.agents[0]!)).toBeNull();
  });
});

describe("applyStageVisibility", () => {
  const model = deriveStageModel({
    activities: [
      spawn(),
      activity({
        kind: "task.started",
        createdAt: at("0:30"),
        payload: { taskId: "task-2", taskType: "local_agent", title: "Review" },
      }),
    ],
    messages: [],
    session: session("running"),
    latestTurn: latestTurn("running"),
  });

  it("takes hidden agents off the stage and hands them back for the roster", () => {
    const result = applyStageVisibility(model, ["task-1"]);
    expect(result.model.agents.map((agent) => agent.id)).toEqual([MAIN_AGENT_ID, "task-2"]);
    expect(result.hidden.map((agent) => agent.id)).toEqual(["task-1"]);
    expect(result.model.attention).toBe(model.attention);
  });

  it("never hides the first agent and returns the model untouched when nothing applies", () => {
    expect(applyStageVisibility(model, [MAIN_AGENT_ID, "nobody"]).model).toBe(model);
    expect(applyStageVisibility(model, []).model).toBe(model);
  });
});

describe("stationForToolName", () => {
  it("maps provider tool names onto stations", () => {
    expect(stationForToolName("Read")).toBe("read");
    expect(stationForToolName("Edit")).toBe("edit");
    expect(stationForToolName("Bash")).toBe("command");
    expect(stationForToolName("Grep")).toBe("search");
    expect(stationForToolName("Agent")).toBe("delegate");
    expect(stationForToolName("preview_click")).toBe("browser");
    expect(stationForToolName("mcp__notion__search", "browser")).toBe("browser");
    expect(stationForToolName("SomethingElse")).toBe("tool");
  });
});

describe("stageInitials", () => {
  it("takes the first letter of the first two words, or two of a single word", () => {
    expect(stageInitials("Fix the login bug")).toBe("FT");
    expect(stageInitials("agent-stage everything")).toBe("AS");
    expect(stageInitials("Refactor")).toBe("RE");
    expect(stageInitials("v2 release")).toBe("VR");
    expect(stageInitials("   ")).toBe("");
  });
});
