/**
 * Fork: what the Initiatives page derives from the server's records and the
 * client's own thread list. Live thread state comes from the thread shells the
 * client already has, so the server sends no extra traffic for it.
 */
import type {
  EnvironmentId,
  InitiativeProject,
  InitiativeSession,
  InitiativeSummary,
  InitiativeThreadUsage,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { type InitiativeSessionState, sessionStateOf } from "@t3tools/initiatives/model";

export interface ShellWithEnvironment extends OrchestrationThreadShell {
  readonly environmentId: EnvironmentId;
}

export interface SessionRow {
  readonly session: InitiativeSession;
  readonly shell: ShellWithEnvironment | null;
  readonly state: InitiativeSessionState;
  readonly title: string;
}

const shellKey = (environmentId: string | null, threadId: string) =>
  `${environmentId ?? ""}|${threadId}`;

/** Sessions with their live shell, newest activity first; released ones are left out. */
export function sessionRows(input: {
  readonly sessions: ReadonlyArray<InitiativeSession>;
  readonly shells: ReadonlyArray<ShellWithEnvironment>;
  readonly homeEnvironmentId: EnvironmentId;
  readonly nowMs: number;
}): ReadonlyArray<SessionRow> {
  const byKey = new Map(
    input.shells.map((shell) => [shellKey(shell.environmentId, shell.id), shell]),
  );
  return input.sessions
    .filter((session) => session.assignment !== "released")
    .map((session) => {
      const shell = session.threadId
        ? (byKey.get(
            shellKey(session.environmentId ?? input.homeEnvironmentId, session.threadId),
          ) ?? null)
        : null;
      return {
        session,
        shell,
        state: sessionStateOf(shell, input.nowMs),
        title: shell?.title ?? session.title,
      };
    })
    .toSorted((a, b) =>
      (b.shell?.updatedAt ?? b.session.updatedAt).localeCompare(
        a.shell?.updatedAt ?? a.session.updatedAt,
      ),
    );
}

/**
 * Threads in one of the initiative's projects that belong to no initiative
 * yet and were not taken out of this one: candidates to confirm.
 */
export function suggestedThreads(input: {
  readonly projects: ReadonlyArray<InitiativeProject>;
  readonly sessions: ReadonlyArray<InitiativeSession>;
  readonly assignedElsewhere: ReadonlyArray<InitiativeSummary>;
  readonly shells: ReadonlyArray<ShellWithEnvironment>;
  readonly homeEnvironmentId: EnvironmentId;
}): ReadonlyArray<ShellWithEnvironment> {
  const projectKeys = new Set(
    input.projects.flatMap((project) =>
      project.projectId
        ? [`${project.environmentId ?? input.homeEnvironmentId}|${project.projectId}`]
        : [],
    ),
  );
  const taken = new Set<string>();
  for (const session of input.sessions) {
    if (session.threadId)
      taken.add(shellKey(session.environmentId ?? input.homeEnvironmentId, session.threadId));
  }
  for (const summary of input.assignedElsewhere) {
    for (const thread of summary.threads) {
      taken.add(shellKey(thread.environmentId ?? input.homeEnvironmentId, thread.threadId));
    }
  }
  return input.shells
    .filter(
      (shell) =>
        shell.archivedAt === null &&
        projectKeys.has(`${shell.environmentId}|${shell.projectId}`) &&
        !taken.has(shellKey(shell.environmentId, shell.id)),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type StateCounts = Partial<Record<InitiativeSessionState, number>>;

export function countStates(rows: ReadonlyArray<Pick<SessionRow, "state">>): StateCounts {
  const counts: StateCounts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return counts;
}

/** The known API-equivalent cost of the threads, and how many had none to read. */
export function totalCost(usage: ReadonlyArray<InitiativeThreadUsage>): {
  readonly costUsd: number;
  readonly unknown: number;
} {
  let costUsd = 0;
  let unknown = 0;
  for (const entry of usage) {
    if (entry.costUsd === null) unknown += 1;
    else costUsd += entry.costUsd;
  }
  return { costUsd, unknown };
}

export function formatUsd(value: number): string {
  return value.toLocaleString("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 10 ? 2 : 0,
  });
}
