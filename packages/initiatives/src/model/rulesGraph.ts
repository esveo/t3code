/**
 * Rules and the task graph of an initiative: which lessons every new thread
 * starts with, and which tasks wait on which. Pure, so the server's prompts
 * and tools and the clients read both the same way.
 */
import type { InitiativeEntry, InitiativeEntryLink } from "@t3tools/contracts";

// ── Rules ────────────────────────────────────────────────────────────────

/** How many rules a start prompt carries, and how long each may be there. */
export const RULES_PROMPT_LIMIT = 30;
export const RULE_PROMPT_LENGTH = 300;

/** The initiative's active rules, oldest first, so their numbers stay put. */
export function activeRules(
  entries: ReadonlyArray<InitiativeEntry>,
): ReadonlyArray<InitiativeEntry> {
  return entries
    .filter((entry) => entry.type === "rule" && entry.status === "active")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The rules as the start prompt carries them: the title is the rule itself. */
export function rulesForPrompt(entries: ReadonlyArray<InitiativeEntry>): ReadonlyArray<string> {
  return activeRules(entries)
    .slice(0, RULES_PROMPT_LIMIT)
    .map((rule) =>
      rule.title.length > RULE_PROMPT_LENGTH
        ? `${rule.title.slice(0, RULE_PROMPT_LENGTH - 1)}…`
        : rule.title,
    );
}

// ── Task graph ───────────────────────────────────────────────────────────

/** Statuses after which a dependency has delivered what the task reads. */
const DELIVERED_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "valid",
  "confirmed",
  "answered",
  "defaulted",
]);

export interface TaskDependency {
  readonly entryId: string;
  /** Null when the entry is gone or of another initiative. */
  readonly entry: InitiativeEntry | null;
  readonly done: boolean;
  /** What the dependency hands over to the task, as its creator named it. */
  readonly passes: string | null;
}

export interface TaskNode {
  readonly dependsOn: ReadonlyArray<TaskDependency>;
  /** Open, and every dependency delivered: the task can start now. */
  readonly ready: boolean;
}

/** Where a task keeps what each dependency passes to it, by dependency id. */
export const TASK_PASSES_KEY = "passes";

export function passesOf(entry: Pick<InitiativeEntry, "details">): Record<string, string> {
  const passes = entry.details[TASK_PASSES_KEY];
  if (typeof passes !== "object" || passes === null) return {};
  return Object.fromEntries(
    Object.entries(passes).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  );
}

/**
 * Every task with what it depends on (its dependsOn links and the entry's
 * own dependsOn) and whether it is ready. One level only: a task waits on
 * its direct dependencies, which in turn wait on theirs.
 */
export function taskGraph(
  entries: ReadonlyArray<InitiativeEntry>,
  links: ReadonlyArray<InitiativeEntryLink>,
): ReadonlyMap<string, TaskNode> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const linked = new Map<string, Array<string>>();
  for (const link of links) {
    if (link.kind !== "dependsOn") continue;
    linked.set(link.fromId, [...(linked.get(link.fromId) ?? []), link.toId]);
  }
  const graph = new Map<string, TaskNode>();
  for (const task of entries) {
    if (task.type !== "task") continue;
    const passes = passesOf(task);
    const ids = [...new Set([...(linked.get(task.id) ?? []), ...task.dependsOn])];
    const dependsOn = ids.map((entryId) => {
      const entry = byId.get(entryId) ?? null;
      return {
        entryId,
        entry,
        done: entry !== null && DELIVERED_STATUSES.has(entry.status),
        passes: passes[entryId] ?? null,
      };
    });
    graph.set(task.id, {
      dependsOn,
      ready: task.status === "open" && dependsOn.every((dependency) => dependency.done),
    });
  }
  return graph;
}

/** Whether a dependsOn link from → to would close a loop, so no task of it could ever start. */
export function closesDependencyLoop(
  links: ReadonlyArray<Pick<InitiativeEntryLink, "fromId" | "toId" | "kind">>,
  fromId: string,
  toId: string,
): boolean {
  const next = new Map<string, Array<string>>();
  for (const link of links) {
    if (link.kind === "dependsOn")
      next.set(link.fromId, [...(next.get(link.fromId) ?? []), link.toId]);
  }
  const seen = new Set<string>();
  const stack = [toId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === fromId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}
