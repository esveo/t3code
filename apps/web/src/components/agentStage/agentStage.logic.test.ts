import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  applyStageVisibility,
  deriveStageModel,
  deriveStageRecap,
  isSearchCommand,
  MAIN_AGENT_ID,
  stageElapsedMs,
  stageInitials,
  stageIsStuck,
  stageStationTimes,
  stationForProgress,
  stationForToolName,
  type StageInput,
  type StageProjection,
} from "./agentStage.logic";

/** `at("0:10")` is ten seconds into the turn, which starts at 10:00:00. */
const at = (seconds: string) => `2026-09-21T10:0${seconds}.000Z`;
const clock = (seconds: string) => Date.parse(at(seconds));
const time = (seconds: string) => DateTime.makeUnsafe(at(seconds));

const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-1");
const INSTANCE = ProviderInstanceId.make("claude");

const run = (
  status: OrchestrationV2Run["status"],
  completedAt: string | null = status === "running" ? null : "1:00",
): OrchestrationV2Run => ({
  id: RUN,
  threadId: THREAD,
  ordinal: 1,
  providerInstanceId: INSTANCE,
  modelSelection: { instanceId: INSTANCE, model: "claude-opus" },
  providerThreadId: null,
  userMessageId: MessageId.make("user-1"),
  rootNodeId: NodeId.make("root"),
  activeAttemptId: null,
  status,
  requestedAt: time("0:00"),
  startedAt: time("0:00"),
  completedAt: completedAt === null ? null : time(completedAt),
  checkpointId: null,
  contextHandoffId: null,
});

let nextId = 0;

type ItemTiming = {
  status?: OrchestrationV2TurnItem["status"];
  start?: string;
  end?: string | null;
  threadId?: ThreadId;
  runId?: RunId | null;
};

function base(timing: ItemTiming) {
  nextId += 1;
  const status = timing.status ?? "completed";
  const start = time(timing.start ?? `0:${String(nextId % 50).padStart(2, "0")}`);
  const end =
    timing.end === null || status === "running" ? null : time(timing.end ?? timing.start ?? "0:00");
  return {
    id: TurnItemId.make(`item-${nextId}`),
    threadId: timing.threadId ?? THREAD,
    runId: timing.runId === undefined ? RUN : timing.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: nextId,
    status,
    title: null,
    startedAt: start,
    completedAt: end,
    updatedAt: end ?? start,
  };
}

const command = (input: string, timing: ItemTiming & { exitCode?: number } = {}) =>
  ({
    ...base(timing),
    type: "command_execution",
    input,
    ...(timing.exitCode === undefined ? {} : { exitCode: timing.exitCode }),
  }) satisfies OrchestrationV2TurnItem;

const readTool = (path: string, timing: ItemTiming = {}) =>
  ({
    ...base(timing),
    type: "dynamic_tool",
    toolName: "Read",
    input: { file_path: path },
  }) satisfies OrchestrationV2TurnItem;

const fileChange = (fileName: string, timing: ItemTiming = {}) =>
  ({ ...base(timing), type: "file_change", fileName }) satisfies OrchestrationV2TurnItem;

const reasoning = (text: string, streaming: boolean, timing: ItemTiming = {}) =>
  ({
    ...base({ status: streaming ? "running" : "completed", ...timing }),
    type: "reasoning",
    text,
    streaming,
  }) satisfies OrchestrationV2TurnItem;

const assistant = (text: string, streaming: boolean, timing: ItemTiming = {}) =>
  ({
    ...base({ status: streaming ? "running" : "completed", ...timing }),
    type: "assistant_message",
    messageId: MessageId.make(`assistant-${text.length}`),
    text,
    streaming,
  }) satisfies OrchestrationV2TurnItem;

const spawnItem = (subagentId: string, timing: ItemTiming = {}) =>
  ({
    ...base(timing),
    type: "subagent",
    subagentId: NodeId.make(subagentId),
    origin: "provider_native",
    driver: ProviderDriverKind.make("claude"),
    providerInstanceId: INSTANCE,
    childThreadId: null,
    prompt: "Find the login bug",
    result: null,
  }) satisfies OrchestrationV2TurnItem;

const approvalItem = (
  requestId: string,
  requestKind: "command" | "file-change",
  prompt: string,
  timing: ItemTiming = {},
) =>
  ({
    ...base({ status: "waiting", ...timing }),
    type: "approval_request",
    requestId: RuntimeRequestId.make(requestId),
    requestKind,
    prompt,
  }) satisfies OrchestrationV2TurnItem;

const questionItem = (requestId: string, question: string, timing: ItemTiming = {}) =>
  ({
    ...base({ status: "waiting", ...timing }),
    type: "user_input_request",
    requestId: RuntimeRequestId.make(requestId),
    questions: [
      {
        id: "q1",
        header: "Scope",
        question,
        options: [
          { label: "web", description: "The web app" },
          { label: "server", description: "The server" },
        ],
      },
    ],
  }) satisfies OrchestrationV2TurnItem;

const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"],
  createdAt: string,
  options: { status?: OrchestrationV2RuntimeRequest["status"]; nodeId?: string } = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make(options.nodeId ?? `node-${id}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: options.status ?? "pending",
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session-1") },
  createdAt: time(createdAt),
  resolvedAt: null,
});

const subagent = (
  id: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => ({
  id: NodeId.make(id),
  threadId: THREAD,
  runId: RUN,
  parentNodeId: NodeId.make("root"),
  origin: "provider_native",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claude"),
  providerInstanceId: INSTANCE,
  providerThreadId: null,
  childThreadId: ThreadId.make(`child-${id}`),
  nativeTaskRef: null,
  prompt: "Audit the auth flow",
  title: "Audit",
  model: null,
  status: "running",
  result: null,
  startedAt: time("0:05"),
  completedAt: null,
  updatedAt: time("0:05"),
  ...overrides,
});

function row(item: OrchestrationV2TurnItem, position = 0): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

const rows = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  items.map((item, index) => row(item, index));

function projection(input: {
  runs?: ReadonlyArray<OrchestrationV2Run>;
  items?: ReadonlyArray<OrchestrationV2TurnItem>;
  subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  nodes?: StageProjection["nodes"];
  providerTurns?: StageProjection["providerTurns"];
}): StageProjection {
  const items = input.items ?? [];
  return {
    thread: { activeProviderThreadId: null },
    runs: input.runs ?? [],
    nodes: input.nodes ?? [],
    subagents: input.subagents ?? [],
    runtimeRequests: input.requests ?? [],
    turnItems: items,
    visibleTurnItems: rows(items),
    providerTurns: input.providerTurns ?? [],
    providerThreads: [],
  };
}

const stage = (
  input: Parameters<typeof projection>[0],
  extra: Omit<StageInput, "projection"> = {},
) => deriveStageModel({ projection: projection(input), ...extra });

describe("deriveStageModel", () => {
  it("rests the main agent at idle when the thread has no turn", () => {
    for (const model of [deriveStageModel({ projection: null }), stage({})]) {
      expect(model.running).toBe(false);
      expect(model.agents).toEqual([
        expect.objectContaining({
          id: MAIN_AGENT_ID,
          station: "idle",
          live: false,
          headline: "Waiting for a prompt",
        }),
      ]);
    }
  });

  it("puts a running command at the terminal with the command as detail", () => {
    const model = stage({
      runs: [run("running")],
      items: [
        reasoning("Let me run the tests.", false, { start: "0:05" }),
        command("npm test", { status: "running", start: "0:10" }),
      ],
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("command");
    expect(main.thought).toBe("Let me run the tests.");
    expect(main.live).toBe(true);
    expect(main.headline).toMatch(/^Running/);
    expect(main.detail).toBe("npm test");
  });

  it("moves to thinking once the tool completes and reasoning streams", () => {
    const model = stage({
      runs: [run("running")],
      items: [
        fileChange("src/app.ts", { start: "0:10", end: "0:12" }),
        reasoning("Now I should check the tests.", true, { start: "0:13" }),
      ],
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("thinking");
    expect(main.detail).toBe("Now I should check the tests.");
    expect(main.thought).toBe("Now I should check the tests.");
  });

  it("answers while the assistant message streams", () => {
    const model = stage({
      runs: [run("running")],
      items: [assistant("Here is what I found.", true)],
    });
    expect(model.agents[0]!.station).toBe("writing");
  });

  it("waits for the user while an approval is open", () => {
    const model = stage({
      runs: [run("running")],
      items: [approvalItem("req-1", "command", "rm -rf build")],
      requests: [request("req-1", "command", "0:10")],
    });
    expect(model.agents[0]).toEqual(
      expect.objectContaining({ station: "waiting", detail: "rm -rf build" }),
    );
  });

  it("shows subagents at their own tool while the main agent waits on them", () => {
    const model = stage(
      {
        runs: [run("running")],
        items: [spawnItem("task-1", { status: "running", start: "0:04" })],
        subagents: [subagent("task-1", { title: "Find the login bug" })],
      },
      {
        subagentThreads: new Map([
          [
            "child-task-1",
            rows([
              readTool("src/auth/login.ts", {
                status: "running",
                start: "0:06",
                threadId: ThreadId.make("child-task-1"),
                runId: null,
              }),
            ]),
          ],
        ]),
      },
    );
    expect(model.agents.map((agent) => agent.id)).toEqual([MAIN_AGENT_ID, "task-1"]);
    expect(model.agents[0]).toEqual(
      expect.objectContaining({ station: "delegate", headline: "Waiting for 1 subagent" }),
    );
    expect(model.agents[1]).toEqual(
      expect.objectContaining({
        kind: "subagent",
        label: "Find the login bug",
        station: "read",
        live: true,
        since: at("0:06"),
        childThreadId: "child-task-1",
      }),
    );
  });

  it("settles everyone at idle after the turn", () => {
    const model = stage({
      runs: [run("completed")],
      items: [assistant("Done.", false)],
      subagents: [
        subagent("task-1", { status: "completed", result: "All good", completedAt: time("0:30") }),
      ],
    });
    expect(model.running).toBe(false);
    expect(model.agents.map((agent) => [agent.station, agent.live, agent.headline])).toEqual([
      ["idle", false, "Done"],
      ["idle", false, "Done"],
    ]);
    expect(model.agents[1]!.detail).toBe("All good");
  });

  it("keeps background subagents working after the turn, until they are stopped", () => {
    const afterTurn = stage(
      {
        runs: [run("completed")],
        items: [assistant("Started it.", false)],
        subagents: [subagent("task-1")],
      },
      {
        subagentThreads: new Map([
          [
            "child-task-1",
            rows([
              command("npm run build", {
                status: "running",
                start: "0:20",
                threadId: ThreadId.make("child-task-1"),
                runId: null,
              }),
            ]),
          ],
        ]),
      },
    );
    expect(afterTurn.running).toBe(true);
    expect(afterTurn.agents.map((agent) => [agent.station, agent.live])).toEqual([
      ["delegate", true],
      ["command", true],
    ]);
    expect(afterTurn.agents[0]!.headline).toBe("Waiting for 1 subagent");

    const stopped = stage({
      runs: [run("completed")],
      subagents: [subagent("task-1", { status: "interrupted" })],
    });
    expect(stopped.running).toBe(false);
    expect(stopped.agents.map((agent) => [agent.station, agent.live, agent.headline])).toEqual([
      ["idle", false, "Done"],
      ["idle", false, "Stopped"],
    ]);
  });

  it("leaves out subagents of earlier turns that have settled", () => {
    const model = stage({
      runs: [run("running")],
      subagents: [
        subagent("old", {
          runId: RunId.make("run-0"),
          status: "completed",
          updatedAt: DateTime.makeUnsafe("2026-09-21T09:00:00.000Z"),
        }),
      ],
    });
    expect(model.agents.map((agent) => agent.id)).toEqual([MAIN_AGENT_ID]);
  });
});

describe("background work after the turn", () => {
  it("says working, not thinking, for a subagent that reports no tools", () => {
    const model = stage({ runs: [run("completed")], subagents: [subagent("task-1")] });
    expect(model.agents[1]).toEqual(
      expect.objectContaining({ station: "thinking", live: true, headline: "Working" }),
    );
  });

  it("follows a subagent through the tools its progress lines announce", () => {
    const reading = stage({
      runs: [run("completed")],
      subagents: [
        subagent("task-1", { progress: "Reading src/auth/login.ts", updatedAt: time("0:40") }),
      ],
    });
    expect(reading.agents[1]).toEqual(
      expect.objectContaining({
        station: "read",
        headline: "Reading src/auth/login.ts",
        since: at("0:40"),
      }),
    );

    const summarized = stage({
      runs: [run("completed")],
      subagents: [subagent("task-1", { progress: "Checking the login flow" })],
    });
    expect(summarized.agents[1]).toEqual(
      expect.objectContaining({
        station: "thinking",
        headline: "Working",
        detail: "Checking the login flow",
        thought: "Checking the login flow",
      }),
    );
  });

  it("parks the main agent at monitoring while a watch loop runs", () => {
    const tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
      { taskId: "watch-1", kind: "monitor", description: "CI checks on #41" },
    ];
    const model = stage({ runs: [run("completed", "0:30")] }, { pendingBackgroundTasks: tasks });
    expect(model.running).toBe(true);
    expect(model.agents).toEqual([
      expect.objectContaining({
        station: "monitoring",
        live: true,
        headline: "Monitoring",
        detail: "CI checks on #41",
        since: at("0:30"),
      }),
    ]);
    expect(stageIsStuck(model.agents[0]!, Date.parse("2026-09-22T10:00:00.000Z"))).toBe(false);
  });

  it("keeps background work the roster does not name, and ranks it over watching", () => {
    const model = stage(
      { runs: [run("completed")] },
      {
        pendingBackgroundTasks: [
          { taskId: "shell-1", kind: "command", description: "pnpm dev" },
          { taskId: "task-1", kind: "background_task" },
        ],
      },
    );
    expect(model.agents[0]).toEqual(
      expect.objectContaining({ station: "delegate", live: true, headline: "Background work" }),
    );
  });
});

describe("stage attention", () => {
  it("offers an open approval with the request behind it", () => {
    const model = stage({
      runs: [run("running")],
      items: [
        {
          ...approvalItem("req-1", "command", "rm -rf build"),
          options: [
            { decision: "decline", label: "Decline" },
            { decision: "accept", label: "Approve" },
          ],
        },
      ],
      requests: [request("req-1", "command", "0:20")],
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
    expect(model.attention[0]!.approval?.responseCapability).toBe("live");
  });

  it("takes questions and waiting subagents too, oldest first", () => {
    const model = stage({
      runs: [run("running")],
      items: [
        questionItem("req-2", "Which package should I touch?"),
        approvalItem("req-3", "file-change", "src/app.ts"),
      ],
      requests: [request("req-2", "user_input", "0:30"), request("req-3", "file-change", "0:10")],
      subagents: [subagent("task-1", { status: "waiting", updatedAt: time("0:40") })],
    });
    expect(model.attention.map((item) => item.kind)).toEqual(["approval", "question", "subagent"]);
    expect(model.attention[1]!.title).toBe("Which package should I touch?");
    expect(model.attention[1]!.approval).toBeNull();
    expect(model.attention[2]).toEqual(
      expect.objectContaining({ agentId: "task-1", title: "Audit is waiting for you" }),
    );
  });

  it("points a subagent's approval at the subagent", () => {
    const model = stage({
      runs: [run("running")],
      items: [approvalItem("req-6", "command", "npm test")],
      requests: [request("req-6", "command", "0:20", { nodeId: "approval-node" })],
      subagents: [subagent("task-1")],
      nodes: [
        {
          id: NodeId.make("approval-node"),
          threadId: THREAD,
          runId: RUN,
          parentNodeId: NodeId.make("task-1"),
          rootNodeId: NodeId.make("root"),
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: RuntimeRequestId.make("req-6"),
          checkpointScopeId: null,
          startedAt: time("0:20"),
          completedAt: null,
        },
      ],
    });
    expect(model.attention.map((item) => item.agentId)).toEqual(["task-1"]);
  });

  it("stays empty once the request is resolved", () => {
    const model = stage({
      runs: [run("running")],
      items: [approvalItem("req-4", "command", "npm test")],
      requests: [request("req-4", "command", "0:10", { status: "resolved" })],
    });
    expect(model.attention).toEqual([]);
  });
});

describe("stage station time", () => {
  it("charges a finished step to its station and the gap before it to thinking", () => {
    const model = stage({
      runs: [run("running")],
      items: [command("npm test", { start: "0:10", end: "0:40" })],
    });
    expect(model.agents[0]!.stationTimes).toEqual([
      { station: "command", ms: 30_000 },
      { station: "thinking", ms: 10_000 },
    ]);
  });

  it("keeps the running step out of the totals and adds it back at render", () => {
    const model = stage({
      runs: [run("running")],
      items: [command("npm test", { status: "running", start: "0:10" })],
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

  it("does not count parallel calls twice", () => {
    const model = stage({
      runs: [run("running")],
      items: [
        readTool("src/a.ts", { start: "0:10", end: "0:20" }),
        readTool("src/b.ts", { start: "0:12", end: "0:25" }),
      ],
    });
    expect(model.agents[0]!.stationTimes).toEqual([
      { station: "read", ms: 15_000 },
      { station: "thinking", ms: 10_000 },
    ]);
  });

  it("calls a station stuck once its own patience runs out", () => {
    const model = stage({
      runs: [run("running")],
      items: [approvalItem("req-5", "command", "npm test")],
      requests: [request("req-5", "command", "0:10")],
    });
    const main = model.agents[0]!;
    expect(main.station).toBe("waiting");
    expect(stageIsStuck(main, clock("1:00"))).toBe(false);
    expect(stageIsStuck(main, clock("3:00"))).toBe(true);
  });

  it("rests without a clock once the turn is over", () => {
    const model = stage({ runs: [run("completed")], items: [assistant("Done.", false)] });
    const main = model.agents[0]!;
    expect(main.since).toBeNull();
    expect(stageElapsedMs(main, clock("9:00"))).toBeNull();
    expect(stageIsStuck(main, clock("9:00"))).toBe(false);
  });
});

describe("stage alerts", () => {
  it("calls out a step the agent keeps repeating", () => {
    const model = stage({
      runs: [run("running")],
      items: [0, 1, 2].map((index) =>
        command("npm test", { start: `0:1${index}`, end: `0:1${index}` }),
      ),
    });
    expect(model.agents[0]!.alerts).toEqual([
      expect.objectContaining({ kind: "repeating", text: "npm test 3 times over" }),
    ]);
  });

  it("calls out a run of failing steps", () => {
    const model = stage({
      runs: [run("running")],
      items: [0, 1].map((index) =>
        command(`npm run check-${index}`, {
          status: "failed",
          start: `0:2${index}`,
          end: `0:2${index}`,
        }),
      ),
    });
    expect(model.agents[0]!.alerts).toContainEqual(
      expect.objectContaining({ kind: "failing", text: "2 of the last 2 steps failed" }),
    );
  });

  it("says a subagent failed", () => {
    const model = stage({
      runs: [run("running")],
      subagents: [subagent("task-1", { status: "failed", result: "Ran out of context" })],
    });
    const failed = model.agents[1]!;
    expect(failed.headline).toBe("Failed");
    expect(failed.alerts).toEqual([
      expect.objectContaining({ kind: "failed", text: "Ran out of context" }),
    ]);
  });
});

const CHILD = ThreadId.make("child-task-1");
const childRead = (index: number, status: "completed" | "failed", path = "src/a.ts") =>
  command(`cat ${path}`, {
    status,
    start: `0:${30 + index}`,
    end: `0:${30 + index}`,
    threadId: CHILD,
    runId: null,
  });

describe("subagent alerts", () => {
  it("calls out a step a subagent keeps repeating", () => {
    const model = stage(
      { runs: [run("running")], subagents: [subagent("task-1")] },
      {
        subagentThreads: new Map([
          [
            "child-task-1",
            rows([childRead(0, "completed"), childRead(1, "completed"), childRead(2, "completed")]),
          ],
        ]),
      },
    );
    expect(model.agents[0]!.alerts).toEqual([]);
    expect(model.agents[1]!.alerts).toEqual([
      expect.objectContaining({ kind: "repeating", text: "cat src/a.ts 3 times over" }),
    ]);
  });

  it("calls out a subagent's failing steps and counts them for the recap", () => {
    const model = stage(
      { runs: [run("running")], subagents: [subagent("task-1")] },
      {
        subagentThreads: new Map([
          [
            "child-task-1",
            rows([
              childRead(0, "failed", "a"),
              childRead(1, "failed", "b"),
              childRead(2, "completed", "c"),
            ]),
          ],
        ]),
      },
    );
    const child = model.agents[1]!;
    expect(child.alerts).toEqual([
      expect.objectContaining({ kind: "failing", text: "2 of the last 3 steps failed" }),
    ]);
    expect(child.steps).toBe(3);
    expect(child.failedSteps).toBe(2);
  });

  it("reads only the subagent's latest activation from its thread", () => {
    const model = stage(
      { runs: [run("running")], subagents: [subagent("task-1", { startedAt: time("0:31") })] },
      {
        subagentThreads: new Map([
          ["child-task-1", rows([childRead(0, "completed"), childRead(1, "completed")])],
        ]),
      },
    );
    expect(model.agents[1]!.steps).toBe(1);
  });
});

describe("stage recap", () => {
  it("says nothing while the agent still works", () => {
    const model = stage({
      runs: [run("running")],
      items: [readTool("src/a.ts", { start: "0:10", end: "0:10" })],
    });
    expect(deriveStageRecap(model.agents[0]!)).toBeNull();
  });

  it("sums the settled turn: steps, failures, and the answer at the end", () => {
    const model = stage({
      runs: [run("completed")],
      items: [
        readTool("src/auth/login.ts", { start: "0:00", end: "0:10" }),
        command("npm test", { status: "failed", start: "0:10", end: "0:20" }),
        assistant("Done.", false, { start: "0:30" }),
      ],
    });
    expect(deriveStageRecap(model.agents[0]!)).toEqual({
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
    const model = stage({
      runs: [run("failed")],
      items: [readTool("src/a.ts", { start: "0:00", end: "0:10" })],
    });
    expect(model.agents[0]!.headline).toBe("The turn failed");
    expect(deriveStageRecap(model.agents[0]!)?.stationTimes).toEqual([
      { station: "thinking", ms: 50_000 },
      { station: "read", ms: 10_000 },
    ]);
  });

  it("stays quiet for a thread that never did anything", () => {
    expect(deriveStageRecap(deriveStageModel({ projection: null }).agents[0]!)).toBeNull();
  });
});

describe("applyStageVisibility", () => {
  const model = stage({
    runs: [run("running")],
    subagents: [subagent("task-1"), subagent("task-2", { startedAt: time("0:30") })],
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

describe("stationForProgress", () => {
  it("reads the station from the tool a progress line names", () => {
    expect(stationForProgress("Reading src/x.ts")).toBe("read");
    expect(stationForProgress("Editing src/x.ts")).toBe("edit");
    expect(stationForProgress("Running npm test")).toBe("command");
    expect(stationForProgress("Searching for subagent handling")).toBe("search");
    expect(stationForProgress("Checking the login flow")).toBe("thinking");
    expect(stationForProgress(null)).toBe("thinking");
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

describe("isSearchCommand", () => {
  it("tells lookups in the shell from other commands", () => {
    expect(isSearchCommand("grep -rn foo src | head")).toBe(true);
    expect(isSearchCommand("cd /repo && rg --files apps")).toBe(true);
    expect(isSearchCommand("Running cd /repo && find . -name '*.ts'")).toBe(true);
    expect(isSearchCommand("Bash: git grep -n agentId")).toBe(true);
    expect(isSearchCommand("Running Search for subagent handling in adapters")).toBe(true);
    expect(isSearchCommand("cd /repo && npx vp test run src")).toBe(false);
    expect(isSearchCommand("Running Inspect Grok background tasks")).toBe(false);
    expect(isSearchCommand(null)).toBe(false);
  });

  it("puts a subagent's grep through the shell at searching", () => {
    const announced = stage({
      runs: [run("completed")],
      subagents: [subagent("task-1", { progress: "Running cd /repo && grep -rn agentId apps" })],
    });
    expect(announced.agents[1]!.station).toBe("search");

    const traced = stage(
      { runs: [run("running")], subagents: [subagent("task-1")] },
      {
        subagentThreads: new Map([
          [
            "child-task-1",
            rows([
              command("rg -n agentId apps", {
                status: "running",
                start: "0:20",
                threadId: CHILD,
                runId: null,
              }),
            ]),
          ],
        ]),
      },
    );
    expect(traced.agents[1]!.station).toBe("search");
    expect(stationForToolName("Bash", undefined, "npm test")).toBe("command");
  });
});

describe("stage findings", () => {
  it("flags a risky command in the turn and a question the answer ends on", () => {
    const model = stage({
      runs: [run("completed")],
      items: [
        command("git push --force origin main", { start: "0:10", end: "0:20" }),
        assistant("Pushed.\n\nShould I open a PR?", false, { start: "0:30" }),
      ],
    });
    expect(model.findings.map((finding) => [finding.kind, finding.agentId, finding.title])).toEqual(
      [
        ["question", MAIN_AGENT_ID, "The answer ends with a question"],
        ["risky", MAIN_AGENT_ID, "Force push"],
      ],
    );
  });

  it("flags a subagent announcing a risky command, and no question while running", () => {
    const model = stage({
      runs: [run("running")],
      items: [assistant("Anything else?", true)],
      subagents: [subagent("task-1", { title: "Cleanup", progress: "Running rm -rf dist" })],
    });
    expect(model.findings).toEqual([
      expect.objectContaining({
        kind: "risky",
        agentId: "task-1",
        title: "Deletes files recursively",
        detail: "rm -rf dist",
      }),
    ]);
  });

  it("flags a nearly full context from the provider's live usage", () => {
    const model = stage({
      runs: [run("running")],
      providerTurns: [
        {
          id: ProviderTurnId.make("turn-1"),
          providerThreadId: ProviderThreadId.make("provider-thread-1"),
          nodeId: NodeId.make("root"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: time("0:00"),
          completedAt: null,
          tokenUsage: { usedTokens: 900, maxTokens: 1000, updatedAt: at("0:50") },
        },
      ],
    });
    expect(model.findings).toEqual([
      expect.objectContaining({ kind: "context", agentId: MAIN_AGENT_ID }),
    ]);
  });
});
