import { ProjectId, ThreadId, TurnId, type OrchestrationLatestTurn } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { StageModel } from "./agentStage.logic";
import {
  deriveFleetStageModel,
  shellHasLiveWork,
  type FleetThread,
  type FleetThreadShell,
} from "./agentStageFleet.logic";

const turn = (state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn => ({
  turnId: TurnId.make("turn-1"),
  state,
  requestedAt: "2026-09-21T09:59:59.000Z",
  startedAt: "2026-09-21T10:00:00.000Z",
  completedAt: state === "running" ? null : "2026-09-21T10:01:00.000Z",
  assistantMessageId: null,
});

function thread(
  key: string,
  overrides: Partial<FleetThreadShell> & { createdAt?: string },
): FleetThread {
  const shell: FleetThreadShell = {
    id: ThreadId.make(key),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${key}`,
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    planProgress: null,
    archivedAt: null,
    createdAt: `2026-09-21T09:0${key.length}:00.000Z`,
    ...overrides,
  };
  return { key, shell, project: { title: "Project" } };
}

const running = (key: string, extra: Partial<FleetThreadShell> = {}) =>
  thread(key, {
    session: {
      threadId: ThreadId.make(key),
      status: "running",
      providerName: "claude",
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-1"),
      lastError: null,
      updatedAt: "2026-09-21T10:00:00.000Z",
    },
    latestTurn: turn("running"),
    ...extra,
  });

const loadedModel: StageModel = {
  running: true,
  attention: [
    {
      id: "question:q-1",
      kind: "question",
      agentId: "main",
      title: "Which branch?",
      detail: null,
      approval: null,
      since: "2026-09-21T10:00:30.000Z",
    },
  ],
  agents: [
    {
      id: "main",
      kind: "main",
      label: "Main agent",
      role: null,
      station: "command",
      live: true,
      headline: "Running npm test",
      detail: "npm test",
      recent: ["Read a.ts"],
      thought: null,
      stationTimes: [{ station: "read", ms: 4_000 }],
      steps: 1,
      failedSteps: 0,
      since: "2026-09-21T10:00:10.000Z",
      alerts: [],
    },
  ],
};

describe("deriveFleetStageModel", () => {
  it("keeps the open thread's full detail and shows only threads with live work", () => {
    const model = deriveFleetStageModel({
      threads: [
        thread("a", {}),
        running("b", { planProgress: { step: "Write tests", completedSteps: 1, totalSteps: 3 } }),
        running("c", { archivedAt: "2026-09-21T10:00:00.000Z" }),
        thread("d", { hasPendingApprovals: true, latestTurn: turn("running") }),
        thread("e", { backgroundLiveness: "working" }),
      ],
      loaded: { key: "a", model: loadedModel },
    });
    expect(
      model.agents.map((agent) => [agent.id, agent.kind, agent.station, agent.headline]),
    ).toEqual([
      ["a", "thread", "command", "Running npm test"],
      ["b", "thread", "thinking", "Working"],
      ["d", "thread", "waiting", "Waiting for your approval"],
      ["e", "thread", "delegate", "Background work"],
    ]);
    expect(model.agents[0]).toEqual(
      expect.objectContaining({
        label: "Thread a",
        role: "Project",
        detail: "npm test",
        stationTimes: [{ station: "read", ms: 4_000 }],
        recent: ["Read a.ts"],
      }),
    );
    expect(model.agents[1]).toEqual(
      expect.objectContaining({
        detail: "Step 2 of 3: Write tests",
        since: "2026-09-21T10:00:00.000Z",
      }),
    );
    expect(model.running).toBe(true);
  });

  it("points requests at their thread and keeps the open thread's answerable", () => {
    const model = deriveFleetStageModel({
      threads: [thread("a", {}), thread("b", { hasPendingUserInput: true })],
      loaded: { key: "a", model: loadedModel },
    });
    expect(model.attention.map((item) => [item.agentId, item.kind, item.title])).toEqual([
      ["b", "question", "Thread b has a question for you"],
      ["a", "question", "Which branch?"],
    ]);
  });

  it("shows no sprite for a thread at rest", () => {
    const model = deriveFleetStageModel({
      threads: [thread("a", { latestTurn: turn("error") })],
      loaded: null,
    });
    expect(model.agents).toEqual([]);
    expect(model.running).toBe(false);
  });
});

describe("shellHasLiveWork", () => {
  it("reads liveness from the shell alone", () => {
    expect(shellHasLiveWork(thread("a", {}).shell)).toBe(false);
    expect(shellHasLiveWork(running("a").shell)).toBe(true);
    expect(shellHasLiveWork(thread("a", { hasPendingUserInput: true }).shell)).toBe(true);
    expect(shellHasLiveWork(thread("a", { backgroundLiveness: "monitoring" }).shell)).toBe(true);
  });
});
