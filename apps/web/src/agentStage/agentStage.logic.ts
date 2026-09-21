import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  foldSubagentActivities,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  liveActivityToolStatus,
  toolGroupAction,
  workLogEntryIsToolLike,
} from "@t3tools/client-runtime/work-log/presentation";
import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { liveWorkEntryLabel } from "../components/chat/MessagesTimeline.logic";
import { deriveWorkLogEntries, type WorkLogEntry } from "../session-logic";

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

export interface StageAgent {
  readonly id: string;
  readonly kind: "main" | "subagent";
  readonly label: string;
  readonly role: string | null;
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
}

export interface StageModel {
  readonly agents: ReadonlyArray<StageAgent>;
  readonly running: boolean;
}

export interface StageInput {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly workspaceRoot?: string | undefined;
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

  const main = deriveMainAgent(input, { running, turnId, liveSubagentCount });
  const agents = [
    main,
    ...subagents
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id))
      .map((agent) => deriveSubagent(agent, toolsByAgent.get(agent.id) ?? null)),
  ];
  return { agents, running };
}

function deriveMainAgent(
  input: StageInput,
  context: { running: boolean; turnId: string | null; liveSubagentCount: number },
): StageAgent {
  const { running, turnId, liveSubagentCount } = context;
  const entries =
    turnId === null
      ? []
      : deriveWorkLogEntries(input.activities).filter((entry) => entry.turnId === turnId);
  const recent = entries
    .filter((entry) => workLogEntryIsToolLike(entry))
    .slice(-RECENT_LIMIT)
    .map((entry) => liveWorkEntryLabel(entry, input.workspaceRoot, false));
  const base = {
    id: MAIN_AGENT_ID,
    kind: "main" as const,
    label: "Main agent",
    role: null,
    recent,
    thought: latestThought(input.messages, turnId),
  };

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
        };
      }
    } else if (workEntryInProgress(current)) {
      return {
        ...base,
        station: stationForWorkEntry(current),
        live: true,
        headline: liveWorkEntryLabel(current, input.workspaceRoot, true),
        detail: workEntryDetail(current),
      };
    }
  }

  const pending = derivePendingRequests(input.activities);
  if (pending.approvals.length > 0) {
    const approval = pending.approvals[pending.approvals.length - 1]!;
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for your approval",
      detail: approval.detail ?? null,
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
      };
    }
    return {
      ...base,
      station: "thinking",
      live: true,
      headline: "Thinking",
      detail: streaming?.role === "reasoning" ? tailSnippet(streaming.text) : null,
    };
  }

  const turnState = input.latestTurn?.state;
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
  };
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

/**
 * The latest tool call of each subagent. Tool rows owned by an agent carry
 * its id; the main timeline hides them, which is exactly why the stage has
 * to read them here.
 */
function collectAttributedTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, AttributedTool> {
  const latest = new Map<string, { toolCallId: string | null; tool: AttributedTool }>();
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
    latest.set(agentId, { toolCallId, tool });
  }
  const result = new Map<string, AttributedTool>();
  for (const [agentId, entry] of latest) result.set(agentId, entry.tool);
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

function deriveSubagent(agent: RuntimeSubagent, tool: AttributedTool | null): StageAgent {
  const label = agent.title && agent.title !== agent.id ? agent.title : (agent.role ?? "Subagent");
  const base = {
    id: agent.id,
    kind: "subagent" as const,
    label,
    role: agent.role,
    recent: agent.recentActivity.slice(-RECENT_LIMIT).map((entry) => entry.summary),
    thought: agent.progress,
  };
  if (agent.status === "running") {
    if (tool !== null && tool.status === "inProgress") {
      return {
        ...base,
        station: stationForToolName(tool.title, tool.surface),
        live: true,
        headline: tool.title ?? "Using a tool",
        detail: tool.command ?? tool.detail,
      };
    }
    return {
      ...base,
      station: "thinking",
      live: true,
      headline: agent.lastToolName ? `Thinking after ${agent.lastToolName}` : "Thinking",
      detail: agent.progress,
    };
  }
  if (agent.status === "waiting") {
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for you",
      detail: agent.progress,
    };
  }
  if (agent.status === "pending") {
    return { ...base, station: "idle", live: true, headline: "Starting", detail: agent.progress };
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
  };
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
