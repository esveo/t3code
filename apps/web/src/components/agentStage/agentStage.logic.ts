import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  toolGroupAction,
  workEntryDisplayIndicatesToolFailure,
} from "@t3tools/client-runtime/work-log/presentation";
import type {
  NodeId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { liveWorkEntryLabel } from "../chat/MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems, type WorkLogEntry } from "../../session-logic";
import {
  contextFinding,
  riskyCommandTitle,
  trailingQuestion,
  type StageFinding,
} from "./agentStageFindings.logic";

export type { StageFinding } from "./agentStageFindings.logic";

/**
 * The stage reduces a thread to one question per agent: where is it right
 * now, and what is it doing there. Stations are the kinds of work an agent
 * moves between; the model is a pure function of the thread so the scene can
 * be driven from any pane, popout or test without the chat's own state.
 */
export type StageStation =
  | "idle"
  | "thinking"
  | "writing"
  | "read"
  | "search"
  | "edit"
  | "command"
  | "browser"
  | "tool"
  | "delegate"
  | "monitoring"
  | "waiting";

/** Clockwise order around the ring, starting at the top. */
export const STAGE_STATIONS: ReadonlyArray<{ readonly id: StageStation; readonly label: string }> =
  [
    { id: "thinking", label: "Thinking" },
    { id: "read", label: "Reading" },
    { id: "search", label: "Searching" },
    { id: "edit", label: "Editing" },
    { id: "command", label: "Terminal" },
    { id: "browser", label: "Browser" },
    { id: "tool", label: "Tools" },
    { id: "delegate", label: "Subagents" },
    { id: "monitoring", label: "Monitoring" },
    { id: "waiting", label: "Waiting" },
    { id: "writing", label: "Answering" },
    { id: "idle", label: "Idle" },
  ];

export const MAIN_AGENT_ID = "main";

/** Time an agent spent at one station during the turn. */
export interface StageStationTime {
  readonly station: StageStation;
  readonly ms: number;
}

/**
 * Something about the agent worth saying out loud: a step it keeps repeating,
 * tools that keep failing, a subagent that died. All of it reads from the
 * thread, so a reload says the same thing.
 */
export interface StageAlert {
  readonly kind: "repeating" | "failing" | "failed";
  readonly text: string;
}

/**
 * An open request standing between the agent and its next step. Approvals
 * carry the request itself, so the stage can answer them where they are shown
 * instead of sending the user back to the composer.
 */
export interface StageAttention {
  readonly id: string;
  readonly kind: "approval" | "question" | "subagent";
  /** The agent held up by it, so the stage can point at its sprite. */
  readonly agentId: string;
  readonly title: string;
  readonly detail: string | null;
  /** Answerable from the stage; questions and subagents are not. */
  readonly approval: ThreadPendingApproval | null;
  readonly since: string;
}

/** What decides a project's icon; the same slice the sidebar's favicon reads. */
export type StageProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
>;

export interface StageAgent {
  readonly id: string;
  /** "thread" is another thread's stand-in, read from its shell alone. */
  readonly kind: "main" | "subagent" | "thread";
  readonly label: string;
  readonly role: string | null;
  /** The thread's project, whose icon the sprite wears; null for subagents. */
  readonly project: StageProject | null;
  /** Two letters from the thread title, badged next to the project icon. */
  readonly initials: string | null;
  readonly station: StageStation;
  /** Still working; settled agents rest at idle, dimmed. */
  readonly live: boolean;
  /** One line: what it does at its station. */
  readonly headline: string;
  /** Command, file, reasoning snippet: the thing the headline is about. */
  readonly detail: string | null;
  /** The latest reasoning of the turn, for the bubble above the sprite. */
  readonly thought: string | null;
  /**
   * Time per station this turn, busiest first, counting finished spans only.
   * The step running right now is added from `since` when the scene draws, so
   * the model stays a pure function of the thread.
   */
  readonly stationTimes: ReadonlyArray<StageStationTime>;
  /** Tool calls this turn, and how many of them failed: the recap's numbers. */
  readonly steps: number;
  readonly failedSteps: number;
  /** When the agent arrived where it stands; null once it rests. */
  readonly since: string | null;
  readonly alerts: ReadonlyArray<StageAlert>;
  /** A subagent's own thread, where its conversation can be opened. */
  readonly childThreadId?: ThreadId | null;
}

export interface StageModel {
  readonly agents: ReadonlyArray<StageAgent>;
  readonly running: boolean;
  /** Open requests, oldest first: what the user has to answer for work to go on. */
  readonly attention: ReadonlyArray<StageAttention>;
  /** Where the user may want to step in, newest first; nothing waits on these. */
  readonly findings: ReadonlyArray<StageFinding>;
}

/** The slice of the V2 thread projection the stage reads. */
export type StageProjection = Pick<
  OrchestrationV2ThreadProjection,
  | "runs"
  | "nodes"
  | "subagents"
  | "runtimeRequests"
  | "turnItems"
  | "visibleTurnItems"
  | "providerTurns"
  | "providerThreads"
> & {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "activeProviderThreadId">;
};

export interface StageInput {
  /** The open thread; null while it loads. */
  readonly projection: StageProjection | null;
  /**
   * The timelines of the subagents' own threads, by thread id. A subagent's
   * tool calls live in its child thread, not in the parent's projection, so
   * the stage can only follow it tool to tool once that thread is loaded.
   */
  readonly subagentThreads?: ReadonlyMap<string, ReadonlyArray<OrchestrationV2ProjectedTurnItem>>;
  /**
   * The shell's roster of work that outlives the turn: background subagents
   * and tasks, and watch loops (monitors, background shells).
   */
  readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly workspaceRoot?: string | undefined;
  /** The thread's title and project, for the main agent's sprite. */
  readonly threadTitle?: string | undefined;
  readonly project?: StageProject | null | undefined;
}

type Run = OrchestrationV2ThreadProjection["runs"][number];

const SNIPPET_LIMIT = 220;
const RUNNING_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running"]);

/** The turn the stage shows: the newest run that has left the queue. */
function stageRun(projection: StageProjection | null): Run | null {
  return projection?.runs.findLast((run) => run.status !== "queued") ?? null;
}

function iso(value: DateTime.Utc): string {
  return DateTime.formatIso(value);
}

/**
 * The subagents on the stage: everyone still at work, wherever they started,
 * and whoever the shown turn spawned, oldest first. Background subagents
 * outlive the turn that started them, so liveness, not the turn, decides.
 */
export function stageSubagents(
  projection: StageProjection | null,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (projection === null) return [];
  const run = stageRun(projection);
  const runStartedAt = run?.startedAt ?? run?.requestedAt ?? null;
  return projection.subagents
    .filter(
      (agent) =>
        isActiveSubagentStatus(agent.status) ||
        (run !== null && agent.runId === run.id) ||
        (runStartedAt !== null &&
          DateTime.toEpochMillis(agent.updatedAt) >= DateTime.toEpochMillis(runStartedAt)),
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.startedAt ?? left.updatedAt) -
          DateTime.toEpochMillis(right.startedAt ?? right.updatedAt) ||
        left.id.localeCompare(right.id),
    );
}

export function deriveStageModel(input: StageInput): StageModel {
  const projection = input.projection;
  const run = stageRun(projection);
  const running = run !== null && RUNNING_RUN_STATUSES.has(run.status);
  const turnStartedAt = run === null ? null : iso(run.startedAt ?? run.requestedAt);
  const rows =
    projection === null || run === null
      ? []
      : projection.visibleTurnItems.filter((row) => row.item.runId === run.id);

  const subagents = stageSubagents(projection);
  const liveSubagentCount = subagents.filter((agent) =>
    isActiveSubagentStatus(agent.status),
  ).length;
  const pending =
    projection === null
      ? { approvals: [], userInputs: [] }
      : derivePendingThreadRequests(projection);
  const requestOwner = requestOwnerResolver(projection, subagents);
  const mainWork = collectWork(rows, input.workspaceRoot, { spawns: true });
  const subagentWork = new Map(
    subagents.map((agent) => {
      const childRows =
        agent.childThreadId === null ? undefined : input.subagentThreads?.get(agent.childThreadId);
      return [
        agent.id,
        childRows === undefined ? null : collectSubagentWork(agent, childRows, input),
      ];
    }),
  );

  const main = deriveMainAgent(input, {
    run,
    running,
    rows,
    turnStartedAt,
    liveSubagentCount,
    pending,
    work: mainWork,
  });
  const agents = [
    main,
    ...subagents.map((agent) =>
      deriveSubagent(agent, subagentWork.get(agent.id) ?? null, input.workspaceRoot),
    ),
  ];
  return {
    agents,
    running: agents.some((agent) => agent.live),
    attention: deriveAttention(pending, subagents, requestOwner),
    findings: deriveFindings(input, {
      run,
      running,
      rows,
      pending,
      mainWork,
      subagents,
      subagentWork,
    }),
  };
}

/**
 * The agent a request holds up: the subagent whose node it hangs under, or
 * the main agent. Providers file a subagent's approvals in the parent thread,
 * under the subagent's node.
 */
function requestOwnerResolver(
  projection: StageProjection | null,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): (requestId: string) => string {
  if (projection === null || subagents.length === 0) return () => MAIN_AGENT_ID;
  const subagentIds = new Set<string>(subagents.map((agent) => agent.id));
  const nodes = new Map(projection.nodes.map((node) => [node.id, node] as const));
  const requests = new Map(
    projection.runtimeRequests.map((request) => [request.id as string, request.nodeId] as const),
  );
  return (requestId) => {
    let nodeId: NodeId | null = requests.get(requestId) ?? null;
    const seen = new Set<string>();
    while (nodeId !== null && !seen.has(nodeId)) {
      if (subagentIds.has(nodeId)) return nodeId;
      seen.add(nodeId);
      nodeId = nodes.get(nodeId)?.parentNodeId ?? null;
    }
    return MAIN_AGENT_ID;
  };
}

/** How many risky commands one agent lists before the oldest drop off. */
const RISKY_PER_AGENT = 3;

function deriveFindings(
  input: StageInput,
  context: {
    run: Run | null;
    running: boolean;
    rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    pending: ReturnType<typeof derivePendingThreadRequests>;
    mainWork: AgentWork;
    subagents: ReadonlyArray<OrchestrationV2Subagent>;
    subagentWork: ReadonlyMap<string, AgentWork | null>;
  },
): ReadonlyArray<StageFinding> {
  const findings: StageFinding[] = [];
  const risky = (agentId: string, key: string, command: string, at: string) => {
    const title = riskyCommandTitle(command);
    if (title === null) return [];
    return [
      {
        id: `risky:${agentId}:${key}`,
        kind: "risky" as const,
        agentId,
        title,
        detail: command,
        since: at,
      },
    ];
  };
  const commandFindings = (agentId: string, work: AgentWork | null) =>
    (work?.steps ?? []).flatMap((step) =>
      step.command === null ? [] : risky(agentId, step.id, step.command, step.start),
    );

  findings.push(...commandFindings(MAIN_AGENT_ID, context.mainWork).slice(-RISKY_PER_AGENT));

  for (const agent of context.subagents) {
    const found = commandFindings(agent.id, context.subagentWork.get(agent.id) ?? null);
    // Claude's progress summaries name the command a subagent is running
    // ("Running rm -rf dist") even when its own thread is not loaded.
    if (agent.progress && isActiveSubagentStatus(agent.status)) {
      found.push(
        ...risky(
          agent.id,
          `progress:${iso(agent.updatedAt)}`,
          agent.progress.replace(/^running\s+/i, ""),
          iso(agent.updatedAt),
        ),
      );
    }
    findings.push(...found.slice(-RISKY_PER_AGENT));
  }

  if (
    !context.running &&
    context.run?.status === "completed" &&
    context.pending.userInputs.length === 0
  ) {
    const answer = context.rows.findLast(
      (row) => row.item.type === "assistant_message" && !row.item.streaming,
    )?.item;
    if (answer?.type === "assistant_message") {
      const question = trailingQuestion(answer.text);
      if (question !== null) {
        findings.push({
          id: `question:${answer.messageId}`,
          kind: "question",
          agentId: MAIN_AGENT_ID,
          title: "The answer ends with a question",
          detail: question,
          since: iso(answer.updatedAt),
        });
      }
    }
  }

  const projection = input.projection;
  if (projection !== null) {
    // The same reading the chat's context meter takes.
    const liveUsage =
      projection.providerTurns.findLast((turn) => turn.tokenUsage !== undefined)?.tokenUsage ??
      null;
    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === projection.thread.activeProviderThreadId,
    );
    const contextFull = contextFinding(
      deriveLatestContextWindowSnapshot(projection.visibleTurnItems, liveUsage, providerThread),
      MAIN_AGENT_ID,
    );
    if (contextFull !== null) findings.push(contextFull);
  }

  return findings.sort((left, right) => right.since.localeCompare(left.since));
}

const APPROVAL_TITLES: Record<string, string> = {
  command: "Approve a command",
  "file-read": "Approve a file read",
  "file-change": "Approve a file change",
  "mcp-elicitation": "Answer an app request",
  permission: "Approve a permission",
};

/**
 * What stands between the agent and its next step, oldest first. The user
 * answers the oldest request first, so that one leads.
 */
function deriveAttention(
  pending: ReturnType<typeof derivePendingThreadRequests>,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  requestOwner: (requestId: string) => string,
): ReadonlyArray<StageAttention> {
  const items: StageAttention[] = [
    ...pending.approvals.map((approval) => ({
      id: `approval:${approval.requestId}`,
      kind: "approval" as const,
      agentId: requestOwner(approval.requestId),
      title: APPROVAL_TITLES[approval.requestKind] ?? "Approve a step",
      detail: approval.detail ?? approval.appName ?? null,
      approval,
      since: approval.createdAt,
    })),
    ...pending.userInputs.map((request) => ({
      id: `question:${request.requestId}`,
      kind: "question" as const,
      agentId: requestOwner(request.requestId),
      title: request.questions[0]?.question ?? "A question for you",
      detail: request.questions.length > 1 ? `and ${request.questions.length - 1} more` : null,
      approval: null,
      since: request.createdAt,
    })),
    ...subagents
      .filter((agent) => agent.status === "waiting")
      .map((agent) => ({
        id: `subagent:${agent.id}`,
        kind: "subagent" as const,
        agentId: agent.id,
        title: `${subagentLabel(agent)} is waiting for you`,
        detail: agent.progress ?? null,
        approval: null,
        since: iso(agent.updatedAt),
      })),
  ];
  return items.sort((left, right) => left.since.localeCompare(right.since));
}

function waitingForSubagents(count: number): string {
  return `Waiting for ${count} ${count === 1 ? "subagent" : "subagents"}`;
}

function deriveMainAgent(
  input: StageInput,
  context: {
    run: Run | null;
    running: boolean;
    rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    turnStartedAt: string | null;
    liveSubagentCount: number;
    pending: ReturnType<typeof derivePendingThreadRequests>;
    work: AgentWork;
  },
): StageAgent {
  const { run, running, rows, turnStartedAt, liveSubagentCount, pending, work } = context;
  const toolSteps = work.steps.filter((step) => !step.spawn);
  const timing = deriveTiming(work.steps, turnStartedAt, {
    // Once the turn is over, the tail after the last step was the answer,
    // unless the turn broke off, in which case nobody was answering.
    settledAt: running || run?.completedAt == null ? null : iso(run.completedAt),
    tailStation: run?.status === "completed" ? "writing" : "thinking",
  });
  const base = {
    id: MAIN_AGENT_ID,
    kind: "main" as const,
    label: "Main agent",
    role: null,
    project: input.project ?? null,
    initials: input.threadTitle === undefined ? null : stageInitials(input.threadTitle),
    thought: latestThought(rows),
    stationTimes: sortStationTimes(timing.times),
    steps: toolSteps.length,
    failedSteps: toolSteps.filter((step) => step.failed).length,
    alerts: deriveStepAlerts(toolSteps),
  };
  const restingAt = running ? (timing.boundary ?? turnStartedAt) : null;

  const current = work.steps.at(-1) ?? null;
  if (current !== null && running) {
    if (current.spawn) {
      if (liveSubagentCount > 0) {
        return {
          ...base,
          station: "delegate",
          live: true,
          headline: waitingForSubagents(liveSubagentCount),
          detail: null,
          since: restingAt,
        };
      }
    } else if (current.running && current.entry !== null) {
      return {
        ...base,
        station: current.station,
        live: true,
        headline: liveWorkEntryLabel(current.entry, input.workspaceRoot, true),
        detail: workEntryDetail(current.entry),
        since: timing.activeSince ?? current.start,
      };
    }
  }

  if (pending.approvals.length > 0) {
    const approval = pending.approvals.at(-1)!;
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for your approval",
      detail: approval.detail ?? null,
      since: approval.createdAt,
    };
  }
  if (pending.userInputs.length > 0) {
    const request = pending.userInputs.at(-1)!;
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for your answer",
      detail: request.questions[0]?.question ?? null,
      since: request.createdAt,
    };
  }

  if (running) {
    if (liveSubagentCount > 0 && current === null) {
      return {
        ...base,
        station: "delegate",
        live: true,
        headline: waitingForSubagents(liveSubagentCount),
        detail: null,
        since: restingAt,
      };
    }
    const streaming = findStreamingItem(rows);
    if (streaming?.type === "assistant_message") {
      return {
        ...base,
        station: "writing",
        live: true,
        headline: "Writing the answer",
        detail: tailSnippet(streaming.text),
        since: restingAt,
      };
    }
    return {
      ...base,
      station: "thinking",
      live: true,
      headline: "Thinking",
      detail: streaming?.type === "reasoning" ? tailSnippet(streaming.text) : null,
      since: restingAt,
    };
  }

  // The turn is over, but work it sent to the background still runs.
  const settledAt = run?.completedAt == null ? null : iso(run.completedAt);
  const background = backgroundWork(input.pendingBackgroundTasks ?? []);
  if (liveSubagentCount > 0 || background?.station === "delegate") {
    return {
      ...base,
      station: "delegate",
      live: true,
      headline: liveSubagentCount > 0 ? waitingForSubagents(liveSubagentCount) : "Background work",
      detail: liveSubagentCount > 0 ? null : (background?.detail ?? null),
      since: settledAt,
    };
  }
  if (background !== null) {
    return {
      ...base,
      station: "monitoring",
      live: true,
      headline: "Monitoring",
      detail: background.detail,
      since: settledAt,
    };
  }

  return {
    ...base,
    station: "idle",
    live: false,
    headline:
      run === null
        ? "Waiting for a prompt"
        : run.status === "failed"
          ? "The turn failed"
          : run.status === "interrupted" || run.status === "cancelled"
            ? "Interrupted"
            : "Done",
    detail: null,
    since: null,
  };
}

/**
 * What the background roster amounts to. Subagents and unnamed tasks are
 * work; monitors and background shells are watch loops, which is what the
 * Monitoring station is for. Work outranks watching.
 */
export function backgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): { readonly station: "delegate" | "monitoring"; readonly detail: string | null } | null {
  const working = tasks.filter(
    (task) => task.kind === "subagent" || task.kind === "background_task",
  );
  if (working.length > 0) {
    return { station: "delegate", detail: working.at(-1)?.description ?? null };
  }
  const watching = tasks.at(-1);
  return watching === undefined
    ? null
    : { station: "monitoring", detail: watching.description ?? null };
}

interface StationTiming {
  readonly times: Map<StageStation, number>;
  /** End of the last accounted span: where the live tail starts. */
  readonly boundary: string | null;
  /** Start of the step running right now, when there is one. */
  readonly activeSince: string | null;
}

/**
 * Time per station for the turn. Each step carries its own start and end, so
 * its span is charged to its station and the gap in front of it to thinking.
 * The step still running is left out; `activeSince` is where it began.
 * Parallel calls overlap, so a span is only counted from the last boundary on.
 */
function deriveTiming(
  steps: ReadonlyArray<StageWorkStep>,
  startedAt: string | null,
  tail: { settledAt: string | null; tailStation: StageStation },
): StationTiming {
  const times = new Map<StageStation, number>();
  let boundary = startedAt;
  let activeSince: string | null = null;
  for (const step of steps) {
    if (boundary !== null && step.start > boundary) {
      addStationTime(times, "thinking", boundary, step.start);
      boundary = step.start;
    }
    boundary ??= step.start;
    if (step.running || step.end === null) {
      activeSince = step.start;
      continue;
    }
    activeSince = null;
    if (step.end > boundary) {
      addStationTime(times, step.station, boundary, step.end);
      boundary = step.end;
    }
  }
  if (tail.settledAt !== null && boundary !== null && activeSince === null) {
    addStationTime(times, tail.tailStation, boundary, tail.settledAt);
    boundary = tail.settledAt;
  }
  return { times, boundary, activeSince };
}

/** One finished tool call, as the alerts read it: what it was, and whether it broke. */
interface StageStep {
  readonly label: string;
  readonly failed: boolean;
}

/** One step of an agent's turn: a tool call, or for the main agent a spawn. */
interface StageWorkStep extends StageStep {
  readonly id: string;
  readonly start: string;
  /** When it finished; null while it runs. */
  readonly end: string | null;
  readonly running: boolean;
  readonly station: StageStation;
  readonly command: string | null;
  readonly spawn: boolean;
  /** The timeline row behind a tool call, for its live label and detail. */
  readonly entry: WorkLogEntry | null;
}

interface AgentWork {
  readonly steps: ReadonlyArray<StageWorkStep>;
}

/** How many of the latest steps a repeat or a run of failures is read from. */
const ALERT_WINDOW = 6;
const REPEAT_LIMIT = 3;

/**
 * A step the agent keeps taking, or steps that keep breaking. Main agent and
 * subagents feed this the same shape, so both get the same warnings.
 */
function deriveStepAlerts(steps: ReadonlyArray<StageStep>): ReadonlyArray<StageAlert> {
  const window = steps.slice(-ALERT_WINDOW);
  if (window.length === 0) return [];
  const alerts: StageAlert[] = [];
  const counts = new Map<string, number>();
  for (const step of window) {
    counts.set(step.label, (counts.get(step.label) ?? 0) + 1);
  }
  const repeated = [...counts]
    .filter(([, count]) => count >= REPEAT_LIMIT)
    .sort((left, right) => right[1] - left[1])[0];
  if (repeated !== undefined) {
    alerts.push({ kind: "repeating", text: `${repeated[0]} ${repeated[1]} times over` });
  }
  const failures = window.filter((step) => step.failed).length;
  if (failures >= 2) {
    alerts.push({ kind: "failing", text: `${failures} of the last ${window.length} steps failed` });
  }
  return alerts;
}

/** Turn items that are work an agent did, as opposed to talk or requests. */
const TOOL_ITEM_TYPES = new Set<OrchestrationV2ProjectedTurnItem["item"]["type"]>([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

/**
 * The tool calls of a timeline, oldest first, in the same shape for the main
 * agent and a subagent's own thread. The chat's timeline derivation labels
 * them, so the stage names a tool the way the chat does.
 */
function collectWork(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  workspaceRoot: string | undefined,
  options: { spawns: boolean },
): AgentWork {
  const toolRows = rows.filter(
    (row) => TOOL_ITEM_TYPES.has(row.item.type) || (options.spawns && row.item.type === "subagent"),
  );
  if (toolRows.length === 0) return { steps: [] };
  const entries = new Map(
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: toolRows,
      optimisticMessages: [],
    }).flatMap((entry) => (entry.kind === "work" ? [[entry.id, entry.entry] as const] : [])),
  );
  return {
    steps: toolRows.flatMap((row): StageWorkStep[] => {
      const { item } = row;
      const running =
        item.status === "pending" || item.status === "running" || item.status === "waiting";
      const start = iso(item.startedAt ?? item.updatedAt);
      const end = running ? null : iso(item.completedAt ?? item.updatedAt);
      if (item.type === "subagent") {
        return [
          {
            id: item.id,
            start,
            end,
            running,
            station: "delegate",
            label: item.title ?? "Subagent",
            failed: item.status === "failed",
            command: null,
            spawn: true,
            entry: null,
          },
        ];
      }
      // Rows the chat leaves out, such as workspace preparation, are no steps.
      const entry = entries.get(item.id);
      if (entry === undefined) return [];
      return [
        {
          id: item.id,
          start,
          end,
          running,
          station: stationForWorkEntry(entry),
          // A command says more than its program name; repeats compare on it.
          label: entry.command ?? liveWorkEntryLabel(entry, workspaceRoot, false),
          failed: workEntryDisplayIndicatesToolFailure(entry),
          command: entry.command ?? null,
          spawn: false,
          entry,
        },
      ];
    }),
  };
}

/** The part of a subagent's own thread that belongs to its latest activation. */
function collectSubagentWork(
  agent: OrchestrationV2Subagent,
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  input: StageInput,
): AgentWork {
  const startedAt = agent.startedAt === null ? null : DateTime.toEpochMillis(agent.startedAt);
  const current =
    startedAt === null
      ? rows
      : rows.filter(
          (row) => DateTime.toEpochMillis(row.item.startedAt ?? row.item.updatedAt) >= startedAt,
        );
  return collectWork(current, input.workspaceRoot, { spawns: false });
}

function latestThought(rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>): string | null {
  const reasoning = rows.findLast((row) => row.item.type === "reasoning")?.item;
  return reasoning?.type === "reasoning" ? tailSnippet(reasoning.text) : null;
}

function findStreamingItem(rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]!.item;
    if (item.type === "user_message") return null;
    if ((item.type === "assistant_message" || item.type === "reasoning") && item.streaming) {
      return item;
    }
  }
  return null;
}

function stationForWorkEntry(entry: WorkLogEntry): StageStation {
  if (entry.itemType === "subagent") return "delegate";
  switch (toolGroupAction(entry)) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "command":
      return isSearchCommand(entry.command) ? "search" : "command";
    case "browser":
    case "device":
      return "browser";
    case "code-search":
    case "search":
      return "search";
    case "thread-create":
      return "delegate";
    case "update":
      return "tool";
    default:
      return stationForToolName(entry.toolTitle ?? entry.label, entry.toolSurface, entry.command);
  }
}

function workEntryDetail(entry: WorkLogEntry): string | null {
  if (entry.command) return entry.command;
  if (entry.changedFiles && entry.changedFiles.length > 0) {
    return entry.changedFiles.join("\n");
  }
  return entry.detail ?? null;
}

/**
 * Tool names as providers report them (Claude: Read, Edit, Bash, Grep, Agent;
 * Codex titles: "Read file", "Run command"). Used where the richer work-log
 * classification is not available, which is every subagent tool call.
 */
export function stationForToolName(
  name: string | null | undefined,
  surface?: "browser" | "computer" | undefined,
  /** The command or its description, which tells a search in the shell from other work. */
  command?: string | null | undefined,
): StageStation {
  const station = stationForToolTitle(name, surface);
  return station === "command" && isSearchCommand(command) ? "search" : station;
}

const SEARCH_COMMAND = /^(grep|egrep|rg|ag|ack|find|fd|ls|tree|locate|git\s+(grep|ls-files))\b/;
const SEARCH_DESCRIPTION = /^(search|find|list|locate|look(ing)?\s+for|grep)\b/i;

/**
 * A shell call that only looks things up. Agents search with grep and find
 * through Bash as often as with their search tools, so the first command that
 * is not a `cd` decides; progress rows also carry the call's description
 * ("Running Search for …") instead of the command.
 */
export function isSearchCommand(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim().replace(/^(running|bash:)\s+/i, "");
  if (SEARCH_DESCRIPTION.test(trimmed)) return true;
  const first = trimmed
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^cd\b/.test(part));
  return first !== undefined && SEARCH_COMMAND.test(first);
}

function stationForToolTitle(
  name: string | null | undefined,
  surface: "browser" | "computer" | undefined,
): StageStation {
  if (surface === "browser" || surface === "computer") return "browser";
  const title = (name ?? "").trim().toLowerCase();
  if (title.length === 0) return "tool";
  if (/^(read|view|cat|notebookread)\b|read file|view file/.test(title)) return "read";
  if (
    /^(edit|write|multiedit|notebookedit|apply_patch|patch)\b|edit file|write file|apply patch/.test(
      title,
    )
  ) {
    return "edit";
  }
  if (/^(grep|glob|search|find|ls|websearch|webfetch|web_search|web search)\b/.test(title)) {
    return "search";
  }
  if (/^(bash|shell|terminal|command|exec|run command|local_shell)\b/.test(title)) return "command";
  if (/^(agent|task|sendmessage|workflow|delegate)\b|subagent/.test(title)) return "delegate";
  if (/browser|preview_|device_|navigate|screenshot|computer/.test(title)) return "browser";
  if (/^(askuserquestion|ask user)/.test(title)) return "waiting";
  return "tool";
}

const PROGRESS_STATIONS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly station: StageStation;
}> = [
  { pattern: /^read(ing)?\b|^view(ing)?\b/i, station: "read" },
  {
    pattern: /^(search(ing)?|find(ing)?|grep(ping)?|glob(bing)?|list(ing)?|look(ing)?\s+for)\b/i,
    station: "search",
  },
  { pattern: /^(fetch(ing)?|web\s*search)\b/i, station: "search" },
  {
    pattern: /^(edit(ing)?|writ(e|ing)|updat(e|ing)|creat(e|ing)|patch(ing)?)\b/i,
    station: "edit",
  },
  { pattern: /^(running|bash:)\s/i, station: "command" },
];

/**
 * Where a progress line puts a subagent. Claude reports a line per tool a
 * subagent starts ("Reading src/x.ts", "Running npm test") and a summary every
 * so often; a line that names no tool leaves it thinking.
 */
export function stationForProgress(progress: string | null | undefined): StageStation {
  const text = progress?.trim() ?? "";
  const match = PROGRESS_STATIONS.find(({ pattern }) => pattern.test(text));
  if (match === undefined) return "thinking";
  return match.station === "command" && isSearchCommand(text) ? "search" : match.station;
}

function subagentLabel(agent: OrchestrationV2Subagent): string {
  if (agent.title) return agent.title;
  const prompt = agent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
}

function deriveSubagent(
  agent: OrchestrationV2Subagent,
  work: AgentWork | null,
  workspaceRoot: string | undefined,
): StageAgent {
  const started = iso(agent.startedAt ?? agent.updatedAt);
  const steps = work?.steps ?? [];
  const timing =
    work === null
      ? null
      : deriveTiming(steps, started, {
          settledAt: null,
          tailStation: "thinking",
        });
  const progress = agent.progress ?? null;
  const stepAlerts = deriveStepAlerts(steps);
  const base = {
    id: agent.id,
    kind: "subagent" as const,
    label: subagentLabel(agent),
    role: null,
    project: null,
    initials: null,
    thought: progress,
    stationTimes: timing === null ? [] : sortStationTimes(timing.times),
    steps: steps.length,
    failedSteps: steps.filter((step) => step.failed).length,
    alerts:
      agent.status === "failed"
        ? [{ kind: "failed" as const, text: agent.result ?? "The subagent failed" }, ...stepAlerts]
        : stepAlerts,
    childThreadId: agent.childThreadId,
  };
  if (agent.status === "running") {
    const current = steps.at(-1);
    if (current?.running && current.entry !== null) {
      return {
        ...base,
        station: current.station,
        live: true,
        headline: liveWorkEntryLabel(current.entry, workspaceRoot, true),
        detail: workEntryDetail(current.entry),
        since: timing?.activeSince ?? current.start,
      };
    }
    // Without its thread's tool calls, the latest progress line is where it
    // works until the next line says otherwise.
    if (work === null || steps.length === 0) {
      const station = stationForProgress(progress);
      if (station !== "thinking") {
        return {
          ...base,
          station,
          live: true,
          headline: progress!,
          detail: null,
          since: iso(agent.updatedAt),
        };
      }
    }
    // Without any tool signal the stage cannot tell thinking from tool use.
    return {
      ...base,
      station: "thinking",
      live: true,
      headline: work === null || steps.length === 0 ? "Working" : "Thinking",
      detail: progress,
      since: timing?.boundary ?? started,
    };
  }
  if (agent.status === "waiting") {
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for you",
      detail: progress,
      since: iso(agent.updatedAt),
    };
  }
  if (agent.status === "pending") {
    return {
      ...base,
      station: "idle",
      live: true,
      headline: "Starting",
      detail: progress,
      since: started,
    };
  }
  return {
    ...base,
    station: "idle",
    live: false,
    headline:
      agent.status === "failed"
        ? "Failed"
        : agent.status === "cancelled" || agent.status === "interrupted"
          ? "Stopped"
          : agent.status === "idle"
            ? "Idle"
            : "Done",
    detail: agent.result ?? progress,
    since: null,
  };
}

function addStationTime(
  times: Map<StageStation, number>,
  station: StageStation,
  from: string,
  to: string,
): void {
  const ms = spanMs(from, to);
  if (ms <= 0) return;
  times.set(station, (times.get(station) ?? 0) + ms);
}

function spanMs(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function sortStationTimes(
  times: ReadonlyMap<StageStation, number>,
): ReadonlyArray<StageStationTime> {
  return [...times]
    .filter(([, ms]) => ms > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([station, ms]) => ({ station, ms }));
}

/**
 * Station times as they are drawn: the finished spans plus the time the agent
 * has already stood where it stands. `now` comes from the scene's own tick, so
 * the model itself never reads the clock.
 */
export function stageStationTimes(agent: StageAgent, now: number): ReadonlyArray<StageStationTime> {
  const live = stageElapsedMs(agent, now);
  if (live === null || live <= 0) return agent.stationTimes;
  const times = new Map(agent.stationTimes.map((entry) => [entry.station, entry.ms] as const));
  times.set(agent.station, (times.get(agent.station) ?? 0) + live);
  return sortStationTimes(times);
}

/** How long the agent has been where it is, or null once it rests. */
export function stageElapsedMs(agent: StageAgent, now: number): number | null {
  if (!agent.live || agent.since === null) return null;
  const since = Date.parse(agent.since);
  if (!Number.isFinite(since)) return null;
  return Math.max(0, now - since);
}

/**
 * When standing still stops being normal. A build or a test run owns the
 * terminal for minutes on end, while a request the user has not answered is
 * worth pointing at much sooner.
 */
export function stageStuckAfterMs(station: StageStation): number {
  if (station === "waiting") return 120_000;
  if (station === "command") return 300_000;
  if (station === "delegate") return 600_000;
  // Watch loops run for hours by design; standing there is the job.
  if (station === "monitoring") return Number.POSITIVE_INFINITY;
  return 180_000;
}

export function stageIsStuck(agent: StageAgent, now: number): boolean {
  if (agent.station === "idle") return false;
  const elapsed = stageElapsedMs(agent, now);
  return elapsed !== null && elapsed >= stageStuckAfterMs(agent.station);
}

function tailSnippet(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const tail = trimmed.length <= SNIPPET_LIMIT ? trimmed : `…${trimmed.slice(-SNIPPET_LIMIT)}`;
  return tail.replace(/\s+/g, " ");
}

/**
 * The stage after the user has hidden some agents. Hiding is a way of
 * looking, not a way of stopping: the first agent (the main agent, or the
 * open thread in the everything view) always stays, so the stage is never
 * empty, and open requests are kept whoever they belong to.
 */
export function applyStageVisibility(
  model: StageModel,
  hiddenIds: ReadonlyArray<string>,
): { readonly model: StageModel; readonly hidden: ReadonlyArray<StageAgent> } {
  if (hiddenIds.length === 0) return { model, hidden: [] };
  const hiddenSet = new Set(hiddenIds);
  const hidden = model.agents.filter((agent, index) => index > 0 && hiddenSet.has(agent.id));
  if (hidden.length === 0) return { model, hidden: [] };
  const hiddenNow = new Set(hidden.map((agent) => agent.id));
  return {
    model: { ...model, agents: model.agents.filter((agent) => !hiddenNow.has(agent.id)) },
    hidden,
  };
}

export interface StageRecap {
  readonly totalMs: number;
  /** Busiest first, as on the agent. */
  readonly stationTimes: ReadonlyArray<StageStationTime>;
  readonly steps: number;
  readonly failedSteps: number;
}

/**
 * What the turn amounted to, once the agent rests. Nothing while it still
 * works, and nothing for an agent that never did anything, so a fresh
 * thread's card stays quiet.
 */
export function deriveStageRecap(agent: StageAgent): StageRecap | null {
  if (agent.live) return null;
  if (agent.steps === 0 && agent.stationTimes.length === 0) return null;
  return {
    totalMs: agent.stationTimes.reduce((sum, entry) => sum + entry.ms, 0),
    stationTimes: agent.stationTimes,
    steps: agent.steps,
    failedSteps: agent.failedSteps,
  };
}

/**
 * Two letters that stand for a thread: the first of its first two words, or
 * the first two of a single word. Sessions of one project share an icon, so
 * this is what tells their sprites apart.
 */
export function stageInitials(title: string): string {
  const words = title.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = words[0];
  if (first === undefined) return "";
  const glyphs = Array.from(first);
  const second = words.length > 1 ? Array.from(words[1]!)[0] : glyphs[1];
  return `${glyphs[0] ?? ""}${second ?? ""}`.toUpperCase();
}
