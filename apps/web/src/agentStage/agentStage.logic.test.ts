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

import { deriveStageModel, MAIN_AGENT_ID, stationForToolName } from "./agentStage.logic";

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
      messages: [],
      session: session("running"),
      latestTurn: latestTurn("running"),
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("command");
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
