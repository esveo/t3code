import {
  derivePendingRequests,
  type PendingApproval,
  type PendingUserInput,
} from "@t3tools/client-runtime/pending-requests";
import {
  foldSubagentActivities,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  liveActivityToolStatus,
  toolGroupAction,
  workEntryDisplayIndicatesToolFailure,
  workLogEntryIsToolLike,
} from "@t3tools/client-runtime/work-log/presentation";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { liveWorkEntryLabel } from "../chat/MessagesTimeline.logic";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";

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
  readonly approval: PendingApproval | null;
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
  /** Latest steps, newest last. */
  readonly recent: ReadonlyArray<string>;
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
}

export interface StageModel {
  readonly agents: ReadonlyArray<StageAgent>;
  readonly running: boolean;
  /** Open requests, oldest first: what the user has to answer for work to go on. */
  readonly attention: ReadonlyArray<StageAttention>;
}

export interface StageInput {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly workspaceRoot?: string | undefined;
  /** The thread's title and project, for the main agent's sprite. */
  readonly threadTitle?: string | undefined;
  readonly project?: StageProject | null | undefined;
}

const RECENT_LIMIT = 5;
const SNIPPET_LIMIT = 220;

export function deriveStageModel(input: StageInput): StageModel {
  const running = input.session?.status === "running";
  const turnId = running
    ? (input.session?.activeTurnId ?? input.latestTurn?.turnId ?? null)
    : (input.latestTurn?.turnId ?? null);
  const turnStartedAt = input.latestTurn?.startedAt ?? null;

  const subagents = foldSubagentActivities(input.activities, { sessionLive: running }).filter(
    (agent) =>
      agent.kind !== "workflow" &&
      (isActiveSubagentStatus(agent.status) ||
        (turnStartedAt !== null && agent.updatedAt >= turnStartedAt)),
  );
  const toolsByAgent = collectAttributedTools(input.activities);
  const liveSubagentCount = subagents.filter((agent) =>
    isActiveSubagentStatus(agent.status),
  ).length;

  const pending = derivePendingRequests(input.activities);

  const main = deriveMainAgent(input, {
    running,
    turnId,
    turnStartedAt,
    liveSubagentCount,
    pending,
  });
  const agents = [
    main,
    ...subagents
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id))
      .map((agent) => deriveSubagent(agent, toolsByAgent.get(agent.id) ?? null)),
  ];
  return { agents, running, attention: deriveAttention(pending, subagents) };
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
  pending: {
    approvals: ReadonlyArray<PendingApproval>;
    userInputs: ReadonlyArray<PendingUserInput>;
  },
  subagents: ReadonlyArray<RuntimeSubagent>,
): ReadonlyArray<StageAttention> {
  const items: StageAttention[] = [
    ...pending.approvals.map((approval) => ({
      id: `approval:${approval.requestId}`,
      kind: "approval" as const,
      agentId: MAIN_AGENT_ID,
      title: APPROVAL_TITLES[approval.requestKind] ?? "Approve a step",
      detail: approval.detail ?? approval.appName ?? null,
      approval,
      since: approval.createdAt,
    })),
    ...pending.userInputs.map((request) => ({
      id: `question:${request.requestId}`,
      kind: "question" as const,
      agentId: MAIN_AGENT_ID,
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
        detail: agent.progress,
        approval: null,
        since: agent.updatedAt,
      })),
  ];
  return items.sort((left, right) => left.since.localeCompare(right.since));
}

function deriveMainAgent(
  input: StageInput,
  context: {
    running: boolean;
    turnId: string | null;
    turnStartedAt: string | null;
    liveSubagentCount: number;
    pending: {
      approvals: ReadonlyArray<PendingApproval>;
      userInputs: ReadonlyArray<PendingUserInput>;
    };
  },
): StageAgent {
  const { running, turnId, turnStartedAt, liveSubagentCount, pending } = context;
  const entries =
    turnId === null
      ? []
      : deriveWorkLogEntries(input.activities).filter((entry) => entry.turnId === turnId);
  const steps = entries.filter(
    (entry) => entry.agentSpawn !== undefined || workLogEntryIsToolLike(entry),
  );
  const toolSteps = entries
    .filter((entry) => workLogEntryIsToolLike(entry))
    .map((entry) => ({
      label: liveWorkEntryLabel(entry, input.workspaceRoot, false),
      failed: workEntryDisplayIndicatesToolFailure(entry),
    }));
  const recent = toolSteps.slice(-RECENT_LIMIT).map((step) => step.label);
  const turnState = input.latestTurn?.state;
  const timing = deriveMainTiming(steps, turnStartedAt, {
    // Once the turn is over, the tail after the last step was the answer,
    // unless the turn broke off, in which case nobody was answering.
    settledAt: running ? null : (input.latestTurn?.completedAt ?? null),
    tailStation: turnState === "completed" ? "writing" : "thinking",
  });
  const base = {
    id: MAIN_AGENT_ID,
    kind: "main" as const,
    label: "Main agent",
    role: null,
    project: input.project ?? null,
    initials: input.threadTitle === undefined ? null : stageInitials(input.threadTitle),
    recent,
    thought: latestThought(input.messages, turnId),
    stationTimes: sortStationTimes(timing.times),
    steps: toolSteps.length,
    failedSteps: toolSteps.filter((step) => step.failed).length,
    alerts: deriveStepAlerts(toolSteps),
  };
  const restingAt = running ? (timing.boundary ?? turnStartedAt) : null;

  const current = findCurrentWorkEntry(entries);
  if (current !== null && running) {
    if (current.agentSpawn !== undefined) {
      if (liveSubagentCount > 0) {
        return {
          ...base,
          station: "delegate",
          live: true,
          headline: `Waiting for ${liveSubagentCount} ${liveSubagentCount === 1 ? "subagent" : "subagents"}`,
          detail: null,
          since: restingAt,
        };
      }
    } else if (workEntryInProgress(current)) {
      return {
        ...base,
        station: stationForWorkEntry(current),
        live: true,
        headline: liveWorkEntryLabel(current, input.workspaceRoot, true),
        detail: workEntryDetail(current),
        since: timing.activeSince ?? current.createdAt,
      };
    }
  }

  if (pending.approvals.length > 0) {
    const approval = pending.approvals[pending.approvals.length - 1]!;
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
    const request = pending.userInputs[pending.userInputs.length - 1]!;
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
        headline: `Waiting for ${liveSubagentCount} ${liveSubagentCount === 1 ? "subagent" : "subagents"}`,
        detail: null,
        since: restingAt,
      };
    }
    const streaming = findStreamingMessage(input.messages, turnId);
    if (streaming?.role === "assistant") {
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
      detail: streaming?.role === "reasoning" ? tailSnippet(streaming.text) : null,
      since: restingAt,
    };
  }

  return {
    ...base,
    station: "idle",
    live: false,
    headline:
      turnState === "error"
        ? "The turn failed"
        : turnState === "interrupted"
          ? "Interrupted"
          : turnId === null
            ? "Waiting for a prompt"
            : "Done",
    detail: null,
    since: null,
  };
}

interface StationTiming {
  readonly times: Map<StageStation, number>;
  /** End of the last accounted span: where the live tail starts. */
  readonly boundary: string | null;
  /** Start of the step running right now, when there is one. */
  readonly activeSince: string | null;
}

/**
 * Time per station for the turn. A finished row carries the moment its work
 * ended, so the span since the row before it is charged to its station; the
 * gap in front of a row that is still running is thinking, and the row's own
 * time is still accruing, which is what `activeSince` is for.
 */
function deriveMainTiming(
  steps: ReadonlyArray<WorkLogEntry>,
  turnStartedAt: string | null,
  tail: { settledAt: string | null; tailStation: StageStation },
): StationTiming {
  const times = new Map<StageStation, number>();
  let boundary = turnStartedAt;
  let activeSince: string | null = null;
  for (const entry of steps) {
    const running = workEntryInProgress(entry);
    if (boundary !== null) {
      addStationTime(
        times,
        running ? "thinking" : stationForWorkEntry(entry),
        boundary,
        entry.createdAt,
      );
    }
    boundary = entry.createdAt;
    activeSince = running ? entry.createdAt : null;
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

/**
 * A tool row still runs while its lifecycle says so. An update without any
 * status is the start of a call whose provider reports no phases, so it counts
 * as running until a completion row replaces it.
 */
function workEntryInProgress(entry: WorkLogEntry): boolean {
  if (entry.toolLifecycleStatus !== undefined) {
    return liveActivityToolStatus(entry.toolLifecycleStatus, false) === "inProgress";
  }
  return entry.sourceActivityKind === "tool.updated";
}

/** The last row that says what the agent is doing: a tool call or a spawn. */
function findCurrentWorkEntry(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.agentSpawn !== undefined || workLogEntryIsToolLike(entry)) return entry;
  }
  return null;
}

function latestThought(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: string | null,
): string | null {
  if (turnId === null) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.turnId === turnId && message.role === "reasoning") {
      return tailSnippet(message.text);
    }
  }
  return null;
}

function findStreamingMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: string | null,
): OrchestrationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.turnId !== turnId) continue;
    if (message.role === "user") return null;
    if (message.streaming) return message;
  }
  return null;
}

function stationForWorkEntry(entry: WorkLogEntry): StageStation {
  if (entry.agentSpawn !== undefined) return "delegate";
  if (entry.itemType === "collab_agent_tool_call") return "delegate";
  switch (toolGroupAction(entry)) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "command":
      return "command";
    case "browser":
    case "device":
      return "browser";
    case "code-search":
    case "search":
      return "search";
    case "update":
      return "tool";
    default:
      return stationForToolName(entry.toolTitle ?? entry.label, entry.toolSurface);
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

interface AttributedTool {
  readonly title: string | null;
  readonly detail: string | null;
  readonly command: string | null;
  readonly surface: "browser" | "computer" | undefined;
  readonly status: "inProgress" | "completed" | "failed" | "declined";
}

interface AttributedWork {
  readonly tool: AttributedTool;
  readonly timing: StationTiming;
  /** Every finished call, oldest first: the alerts read the tail, the recap counts all. */
  readonly steps: ReadonlyArray<StageStep>;
}

/**
 * The latest tool call of each subagent, and how its turn divides between the
 * stations. Tool rows owned by an agent carry its id; the main timeline hides
 * them, which is exactly why the stage has to read them here.
 */
function collectAttributedTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, AttributedWork> {
  const latest = new Map<
    string,
    {
      toolCallId: string | null;
      tool: AttributedTool;
      times: Map<StageStation, number>;
      boundary: string | null;
      activeSince: string | null;
      steps: Array<StageStep & { toolCallId: string | null }>;
    }
  >();
  for (const activity of activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = asRecord(activity.payload);
    if (payload === null) continue;
    const agentId = asString(payload.agentId);
    if (agentId === null) continue;
    const data = asRecord(payload.data);
    const toolCallId = asString(payload.toolCallId) ?? asString(data?.toolCallId);
    const previous = latest.get(agentId);
    const status = toolStatus(payload.status, activity.kind);
    const item = asRecord(data?.item);
    const command =
      asString(item?.command) ??
      asString(asRecord(item?.input)?.command) ??
      asString(data?.command) ??
      null;
    const tool: AttributedTool = {
      title: asString(payload.title) ?? asString(data?.toolName) ?? previous?.tool.title ?? null,
      detail: asString(payload.detail) ?? (activity.summary || null),
      command: command ?? (previous?.toolCallId === toolCallId ? previous.tool.command : null),
      surface:
        payload.toolSurface === "browser" || payload.toolSurface === "computer"
          ? payload.toolSurface
          : undefined,
      status,
    };
    const times = previous?.times ?? new Map<StageStation, number>();
    const steps = previous?.steps ?? [];
    let boundary = previous?.boundary ?? null;
    let activeSince = previous?.activeSince ?? null;
    if (status !== "inProgress") {
      // A call ends once; a second terminal row for it restates, not repeats.
      const step = {
        toolCallId,
        label: [tool.title, tool.command ?? tool.detail].filter(Boolean).join(" "),
        failed: status === "failed",
      };
      const last = steps[steps.length - 1];
      if (last !== undefined && toolCallId !== null && last.toolCallId === toolCallId) {
        steps[steps.length - 1] = step;
      } else {
        steps.push(step);
      }
    }
    if (status === "inProgress") {
      // Progress rows repeat for one call; only its first row starts the clock.
      if (previous === undefined || previous.toolCallId !== toolCallId || activeSince === null) {
        if (boundary !== null) addStationTime(times, "thinking", boundary, activity.createdAt);
        boundary = activity.createdAt;
        activeSince = activity.createdAt;
      }
    } else {
      const from = activeSince ?? boundary;
      if (from !== null) {
        addStationTime(
          times,
          stationForToolName(tool.title, tool.surface),
          from,
          activity.createdAt,
        );
      }
      boundary = activity.createdAt;
      activeSince = null;
    }
    latest.set(agentId, { toolCallId, tool, times, boundary, activeSince, steps });
  }
  const result = new Map<string, AttributedWork>();
  for (const [agentId, entry] of latest) {
    result.set(agentId, {
      tool: entry.tool,
      timing: { times: entry.times, boundary: entry.boundary, activeSince: entry.activeSince },
      steps: entry.steps.map(({ label, failed }) => ({ label, failed })),
    });
  }
  return result;
}

function toolStatus(value: unknown, kind: string): AttributedTool["status"] {
  if (
    value === "inProgress" ||
    value === "completed" ||
    value === "failed" ||
    value === "declined"
  ) {
    return value;
  }
  return kind === "tool.completed" ? "completed" : "inProgress";
}

function subagentLabel(agent: RuntimeSubagent): string {
  return agent.title && agent.title !== agent.id ? agent.title : (agent.role ?? "Subagent");
}

function deriveSubagent(agent: RuntimeSubagent, work: AttributedWork | null): StageAgent {
  const tool = work?.tool ?? null;
  const timing = work?.timing ?? null;
  const started = agent.startedAt ?? agent.firstSeenAt;
  const steps = work?.steps ?? [];
  // Providers that attribute no tool rows still report progress lines; a
  // line that keeps coming back is the same loop, read from the other side.
  const stepAlerts = deriveStepAlerts(
    steps.length > 0
      ? steps
      : agent.recentActivity.map((entry) => ({ label: entry.summary, failed: false })),
  );
  const base = {
    id: agent.id,
    kind: "subagent" as const,
    label: subagentLabel(agent),
    role: agent.role,
    project: null,
    initials: null,
    recent: agent.recentActivity.slice(-RECENT_LIMIT).map((entry) => entry.summary),
    thought: agent.progress,
    stationTimes: timing === null ? [] : sortStationTimes(timing.times),
    steps: steps.length,
    failedSteps: steps.filter((step) => step.failed).length,
    alerts:
      agent.status === "failed"
        ? [{ kind: "failed" as const, text: agent.error ?? "The subagent failed" }, ...stepAlerts]
        : stepAlerts,
  };
  if (agent.status === "running") {
    if (tool !== null && tool.status === "inProgress") {
      return {
        ...base,
        station: stationForToolName(tool.title, tool.surface),
        live: true,
        headline: tool.title ?? "Using a tool",
        detail: tool.command ?? tool.detail,
        since: timing?.activeSince ?? started,
      };
    }
    return {
      ...base,
      station: "thinking",
      live: true,
      headline: agent.lastToolName ? `Thinking after ${agent.lastToolName}` : "Thinking",
      detail: agent.progress,
      since: timing?.boundary ?? started,
    };
  }
  if (agent.status === "waiting") {
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for you",
      detail: agent.progress,
      since: agent.updatedAt,
    };
  }
  if (agent.status === "pending") {
    return {
      ...base,
      station: "idle",
      live: true,
      headline: "Starting",
      detail: agent.progress,
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
    detail: agent.error ?? agent.result ?? agent.progress,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
