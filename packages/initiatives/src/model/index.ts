/**
 * Pure rules of the initiatives module, shared by the server, its MCP tools
 * and the clients, so each shows the same word for the same thing.
 */
import type {
  Initiative,
  InitiativeAuthor,
  OrchestrationThreadShell,
  RuntimeMode,
} from "@t3tools/contracts";
import { resolveChildThreadState } from "@t3tools/shared/threadOrchestration";

// ── Authors ──────────────────────────────────────────────────────────────

export type InitiativeRole = "participant" | "coordinator";

export const personAuthor = (subject: string): InitiativeAuthor => `person:${subject}`;
/** An agent: its role in the initiative, or `agent` for a thread outside one. */
export const agentAuthor = (role: InitiativeRole | "agent", threadId: string): InitiativeAuthor =>
  `role:${role}:${threadId}`;
export const systemAuthor = (job: string): InitiativeAuthor => `system:${job}`;

// ── Runtime mode ─────────────────────────────────────────────────────────

/**
 * Drivers without a built-in reviewer for "auto"; they fall back to accepting
 * edits and asking for the rest.
 */
const NO_AUTO_REVIEW_DRIVERS: ReadonlySet<string> = new Set(["opencode", "antigravity"]);

/**
 * The mode every thread of an initiative runs in, set explicitly on each
 * start: the server default is full access, and a child would inherit its
 * coordinator's mode.
 */
export function initiativeRuntimeMode(driver: string | null | undefined): RuntimeMode {
  return driver && NO_AUTO_REVIEW_DRIVERS.has(driver) ? "auto-accept-edits" : "auto";
}

// ── Tool profiles ────────────────────────────────────────────────────────

/**
 * What each initiative tool needs from its caller. `any` works for every
 * thread, also one outside an initiative; `participant` needs a thread of the
 * initiative; `coordinator` needs the initiative's coordinator. The server
 * checks this on every call: no agent can widen its own profile.
 */
export const INITIATIVE_TOOL_PROFILES = {
  initiative_list: "any",
  initiative_brief: "participant",
  initiative_status: "participant",
  session_list: "participant",
  initiative_create: "any",
  initiative_update: "coordinator",
  initiative_archive: "coordinator",
  initiative_reopen: "coordinator",
  initiative_start_thread: "coordinator",
  session_assign: "coordinator",
  session_unassign: "coordinator",
} as const satisfies Record<string, "any" | InitiativeRole>;

export type InitiativeToolName = keyof typeof INITIATIVE_TOOL_PROFILES;

export function mayUseTool(tool: InitiativeToolName, role: InitiativeRole | null): boolean {
  const needed = INITIATIVE_TOOL_PROFILES[tool];
  if (needed === "any") return true;
  if (role === null) return false;
  return needed === "participant" || role === "coordinator";
}

export function roleOfThread(
  initiative: Pick<Initiative, "coordinatorThreadId">,
  threadId: string,
): InitiativeRole {
  return initiative.coordinatorThreadId === threadId ? "coordinator" : "participant";
}

// ── Session state ────────────────────────────────────────────────────────

export type InitiativeSessionState =
  | "running"
  | "waiting"
  | "stalled"
  | "review"
  | "done"
  | "stopped"
  | "failed"
  | "unknown";

/**
 * How long a working thread may go without any change before it counts as
 * stalled. Same limit as the coordinator's watch on background work
 * (`BACKGROUND_STALL_LIMIT` in ThreadOrchestrationReactor), so both call the
 * same thread stuck.
 */
export const SESSION_STALL_LIMIT_MS = 30 * 60 * 1000;

export type SessionStateShell = Pick<
  OrchestrationThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
  | "pullRequests"
  | "planProgress"
  | "backgroundLiveness"
  | "updatedAt"
>;

export function sessionStateOf(
  shell: SessionStateShell | null | undefined,
  nowMs: number,
): InitiativeSessionState {
  if (!shell) return "unknown";
  const state = resolveChildThreadState(shell);
  switch (state) {
    case "working": {
      const updatedMs = Date.parse(shell.updatedAt);
      return Number.isFinite(updatedMs) && nowMs - updatedMs > SESSION_STALL_LIMIT_MS
        ? "stalled"
        : "running";
    }
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "review":
      return "review";
    case "stopped":
      return "stopped";
    case "done":
      return "done";
  }
}

export const SESSION_STATE_LABELS: Record<InitiativeSessionState, string> = {
  running: "läuft",
  waiting: "wartet",
  stalled: "hängt",
  review: "Review",
  done: "fertig",
  stopped: "abgebrochen",
  failed: "fehlgeschlagen",
  unknown: "unbekannt",
};

// ── Start prompt ─────────────────────────────────────────────────────────

export const INITIATIVE_TAG = "t3_initiative";

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * The block a thread of the initiative starts with: which initiative, which
 * role, its goal and instructions. MCP servers cannot carry per-session
 * instructions, so this is how an agent learns about its initiative.
 */
export function initiativeStartBlock(input: {
  readonly initiative: Pick<Initiative, "id" | "title" | "goalText" | "instructionsMd">;
  readonly role: InitiativeRole;
}): string {
  const { initiative, role } = input;
  const parts = [
    `<${INITIATIVE_TAG} id="${escapeAttribute(initiative.id)}" title="${escapeAttribute(initiative.title)}" role="${role}">`,
    `This thread works on the initiative "${initiative.title}".`,
  ];
  if (initiative.goalText.trim()) parts.push(`Goal: ${initiative.goalText.trim()}`);
  if (initiative.instructionsMd.trim()) {
    parts.push(`Instructions:\n${initiative.instructionsMd.trim()}`);
  }
  parts.push(
    "Read the current brief with initiative_brief and the other work of the initiative with session_list (t3-code MCP server).",
    `</${INITIATIVE_TAG}>`,
  );
  return parts.join("\n");
}

export function initiativeStartPrompt(input: {
  readonly initiative: Pick<Initiative, "id" | "title" | "goalText" | "instructionsMd">;
  readonly role: InitiativeRole;
  readonly prompt: string;
}): string {
  return `${initiativeStartBlock(input)}\n\n${input.prompt.trim()}`;
}
