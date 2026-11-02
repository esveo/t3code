/**
 * Fork (esveo): where an automation runs — a new thread each run, or an
 * existing thread of its project (optionally as a subthread of it).
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

interface LocationDraft {
  readonly projectId: string;
  /** Empty means a new thread each run. */
  readonly threadId: string;
  readonly spawnAsSubthread: boolean;
}

/** A new thread each run never spawns subthreads. */
export function withScheduledTaskThread<D extends LocationDraft>(draft: D, threadId: string): D {
  return {
    ...draft,
    threadId,
    spawnAsSubthread: threadId === "" ? false : draft.spawnAsSubthread,
  };
}

/** A thread belongs to one project, so switching projects drops the binding. */
export function withScheduledTaskProject<D extends LocationDraft>(draft: D, projectId: string): D {
  if (projectId === draft.projectId) return draft;
  return withScheduledTaskThread({ ...draft, projectId }, "");
}

/** Most picker rows worth rendering; typing narrows the rest. */
export const THREAD_PICKER_LIMIT = 50;

/** The project's own threads a task can bind to, most recently updated first. */
export function scheduledTaskThreadOptions(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  query: string,
): ReadonlyArray<EnvironmentThreadShell> {
  const needle = query.trim().toLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.lineage.relationshipToParent !== "subagent" &&
        (needle === "" || thread.title.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, THREAD_PICKER_LIMIT);
}
