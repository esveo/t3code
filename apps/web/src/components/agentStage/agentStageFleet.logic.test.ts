import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { StageModel, StageProject } from "./agentStage.logic";
import {
  deriveFleetStageModel,
  shellHasLiveWork,
  type FleetThread,
  type FleetThreadShell,
} from "./agentStageFleet.logic";

const latestRun = (status: ThreadRunSummary["status"]): ThreadRunSummary => ({
  runId: RunId.make("run-1"),
  status,
  requestedAt: "2026-09-21T09:59:59.000Z",
  startedAt: "2026-09-21T10:00:00.000Z",
  completedAt: status === "running" ? null : "2026-09-21T10:01:00.000Z",
  assistantMessageId: null,
});

const project: StageProject = {
  environmentId: EnvironmentId.make("env-1"),
  workspaceRoot: "/repo",
  title: "Project",
  faviconPath: null,
  projectIcon: null,
};

function thread(
  key: string,
  overrides: Partial<FleetThreadShell> & { createdAt?: string },
): FleetThread {
  const shell: FleetThreadShell = {
    id: ThreadId.make(key),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${key}`,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(key) },
    archivedAt: null,
    createdAt: `2026-09-21T09:0${key.length}:00.000Z`,
    ...overrides,
  };
  return { key, shell, project };
}

const running = (key: string, extra: Partial<FleetThreadShell> = {}) =>
  thread(key, {
    runtime: {
      status: "running",
      activeRunId: RunId.make("run-1"),
      activityStartedAt: "2026-09-21T10:00:00.000Z",
      providerInstanceId: ProviderInstanceId.make("claude"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-09-21T10:00:00.000Z",
    },
    latestRun: latestRun("running"),
    ...extra,
  });

const loadedModel: StageModel = {
  running: true,
  findings: [
    {
      id: "risky:main:call-1",
      kind: "risky",
      agentId: "main",
      title: "Force push",
      detail: "git push -f",
      since: "2026-09-21T10:00:20.000Z",
    },
  ],
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
      project: null,
      initials: null,
      station: "command",
      live: true,
      headline: "Running npm test",
      detail: "npm test",
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
        running("b"),
        running("c", { archivedAt: "2026-09-21T10:00:00.000Z" }),
        thread("d", { hasPendingApprovals: true, latestRun: latestRun("running") }),
        thread("e", { pendingBackgroundTasks: [{ taskId: "t-1", kind: "subagent" }] }),
        running("f", {
          lineage: {
            parentThreadId: ThreadId.make("e"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("e"),
          },
        }),
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
        project,
        initials: "TA",
        detail: "npm test",
        stationTimes: [{ station: "read", ms: 4_000 }],
      }),
    );
    expect(model.agents[1]).toEqual(expect.objectContaining({ since: "2026-09-21T10:00:00.000Z" }));
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

  it("sends watch loops to monitoring and other background work to subagents", () => {
    const model = deriveFleetStageModel({
      threads: [
        thread("a", {
          pendingBackgroundTasks: [{ taskId: "w-1", kind: "monitor", description: "CI on #41" }],
        }),
        thread("bb", { pendingBackgroundTasks: [{ taskId: "t-1", kind: "background_task" }] }),
      ],
      loaded: null,
    });
    expect(
      model.agents.map((agent) => [agent.id, agent.station, agent.headline, agent.detail]),
    ).toEqual([
      ["a", "monitoring", "Monitoring", "CI on #41"],
      ["bb", "delegate", "Background work", null],
    ]);
  });

  it("keeps the open thread's findings on its sprite", () => {
    const model = deriveFleetStageModel({
      threads: [running("a")],
      loaded: { key: "a", model: loadedModel },
    });
    expect(model.findings.map((finding) => [finding.agentId, finding.title])).toEqual([
      ["a", "Force push"],
    ]);
  });

  it("shows no sprite for a thread at rest", () => {
    const model = deriveFleetStageModel({
      threads: [thread("a", { latestRun: latestRun("failed") })],
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
    expect(
      shellHasLiveWork(
        thread("a", { pendingBackgroundTasks: [{ taskId: "w-1", kind: "monitor" }] }).shell,
      ),
    ).toBe(true);
  });
});
