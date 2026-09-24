import type { OrchestrationThreadShell } from "@t3tools/contracts";

import {
  stageInitials,
  type StageAgent,
  type StageAttention,
  type StageFinding,
  type StageModel,
  type StageProject,
} from "./agentStage.logic";

/**
 * The stage for every thread at once. It reads nothing but the thread shells
 * every client already holds for the sidebar, so it costs no wire traffic,
 * and it says only what a shell can say: working, waiting for the user,
 * background work, or at rest, plus the plan step. The open thread is the
 * exception: its activities are loaded anyway, so its sprite carries the
 * full model of its main agent, arcs, steps and all.
 */
export type FleetThreadShell = Pick<
  OrchestrationThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "session"
  | "latestTurn"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
  | "planProgress"
  | "archivedAt"
  | "createdAt"
>;

export interface FleetThread {
  /** The scoped thread key; doubles as the sprite's id. */
  readonly key: string;
  readonly shell: FleetThreadShell;
  readonly project: StageProject | null;
}

export interface FleetInput {
  readonly threads: ReadonlyArray<FleetThread>;
  /** The open thread and its own stage, which stands in for its main agent. */
  readonly loaded: { readonly key: string; readonly model: StageModel } | null;
}

/** A shell that says something is going on in its thread. */
export function shellHasLiveWork(shell: FleetThreadShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  const status = shell.session?.status;
  if (status === "running" || status === "starting") return true;
  return shell.backgroundLiveness === "working" || shell.backgroundLiveness === "monitoring";
}

export function deriveFleetStageModel(input: FleetInput): StageModel {
  const agents: StageAgent[] = [];
  const attention: StageAttention[] = [];
  // Only the open thread's activities are loaded, so only it has findings.
  const findings: StageFinding[] = [];
  const loaded = input.loaded;
  if (loaded !== null) {
    const thread = input.threads.find((candidate) => candidate.key === loaded.key);
    const main = loaded.model.agents[0];
    if (main !== undefined) {
      agents.push({
        ...main,
        id: loaded.key,
        kind: "thread",
        label: thread?.shell.title ?? main.label,
        role: thread?.project?.title ?? null,
        project: thread?.project ?? main.project,
        initials: thread === undefined ? main.initials : stageInitials(thread.shell.title),
      });
      // Its requests keep the request behind them, so they stay answerable.
      for (const item of loaded.model.attention) {
        attention.push({ ...item, agentId: loaded.key });
      }
      for (const finding of loaded.model.findings) {
        findings.push({ ...finding, agentId: loaded.key });
      }
    }
  }
  const others = input.threads
    .filter(
      (thread) =>
        thread.key !== loaded?.key &&
        thread.shell.archivedAt === null &&
        shellHasLiveWork(thread.shell),
    )
    .sort(
      (left, right) =>
        left.shell.createdAt.localeCompare(right.shell.createdAt) ||
        left.key.localeCompare(right.key),
    );
  for (const thread of others) {
    agents.push(deriveShellAgent(thread));
    const request = deriveShellAttention(thread);
    if (request !== null) attention.push(request);
  }
  return {
    agents,
    running: agents.some((agent) => agent.live),
    attention: attention.sort((left, right) => left.since.localeCompare(right.since)),
    findings,
  };
}

function deriveShellAgent(thread: FleetThread): StageAgent {
  const { shell } = thread;
  const base = {
    id: thread.key,
    kind: "thread" as const,
    label: shell.title,
    role: thread.project?.title ?? null,
    project: thread.project,
    initials: stageInitials(shell.title),
    thought: null,
    stationTimes: [],
    steps: 0,
    failedSteps: 0,
    alerts: [],
  };
  const plan = shell.planProgress ?? null;
  const planDetail =
    plan === null
      ? null
      : plan.totalSteps > 0
        ? `Step ${Math.min(plan.completedSteps + 1, plan.totalSteps)} of ${plan.totalSteps}: ${plan.step}`
        : plan.step;
  if (shell.hasPendingApprovals) {
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for your approval",
      detail: planDetail,
      // The shell does not say when the request was made, so no clock runs.
      since: null,
    };
  }
  if (shell.hasPendingUserInput) {
    return {
      ...base,
      station: "waiting",
      live: true,
      headline: "Waiting for your answer",
      detail: planDetail,
      since: null,
    };
  }
  const status = shell.session?.status;
  if (status === "running" || status === "starting") {
    return {
      ...base,
      station: "thinking",
      live: true,
      headline: status === "starting" ? "Starting" : "Working",
      detail: planDetail,
      since: shell.latestTurn?.startedAt ?? null,
    };
  }
  if (shell.backgroundLiveness === "working" || shell.backgroundLiveness === "monitoring") {
    const working = shell.backgroundLiveness === "working";
    return {
      ...base,
      station: working ? "delegate" : "monitoring",
      live: true,
      headline: working ? "Background work" : "Monitoring",
      detail: null,
      since: null,
    };
  }
  const turnState = shell.latestTurn?.state;
  return {
    ...base,
    station: "idle",
    live: false,
    headline:
      turnState === "error"
        ? "The turn failed"
        : turnState === "interrupted"
          ? "Interrupted"
          : shell.latestTurn === null
            ? "Waiting for a prompt"
            : "Done",
    detail: null,
    since: null,
  };
}

/**
 * A shell only knows that a request is open, not which. The stage points at
 * the thread; answering means opening it.
 */
function deriveShellAttention(thread: FleetThread): StageAttention | null {
  const { shell } = thread;
  if (!shell.hasPendingApprovals && !shell.hasPendingUserInput) return null;
  const kind = shell.hasPendingApprovals ? "approval" : "question";
  return {
    id: `${kind}:${thread.key}`,
    kind,
    agentId: thread.key,
    title:
      kind === "approval"
        ? `${shell.title} waits for an approval`
        : `${shell.title} has a question for you`,
    detail: null,
    approval: null,
    since: shell.latestTurn?.startedAt ?? shell.createdAt,
  };
}
