/**
 * Loops of an initiative's work: a task carries a check that can fail before
 * it starts, counts as done only once that check passed (or a person took it
 * without one), and a failed unit goes back alone to the thread that made it,
 * a limited number of times.
 */
import type {
  InitiativeAcceptanceCheck,
  InitiativeCheckResult,
  InitiativeEntry,
} from "@t3tools/contracts";

/** Entry types that carry an acceptance check. */
export const CHECKED_ENTRY_TYPES: ReadonlySet<string> = new Set(["task", "plan"]);

/**
 * Corrections a task gets before the fault is taken to lie in the plan: the
 * next return is not sent but asked as a question in the Inbox.
 */
export const MAX_RETURN_ATTEMPTS = 3;

type LoopEntry = Pick<
  InitiativeEntry,
  "type" | "inbox" | "acceptanceCheck" | "checkResults" | "acceptedWithoutCheckBy"
>;

/** Whether the entry is a task or plan of the initiative's own (not an Inbox item). */
export function isCheckedEntry(entry: Pick<InitiativeEntry, "type" | "inbox">): boolean {
  return CHECKED_ENTRY_TYPES.has(entry.type) && entry.inbox === null;
}

export function latestCheckResult(
  entry: Pick<InitiativeEntry, "checkResults">,
): InitiativeCheckResult | null {
  return entry.checkResults?.at(-1) ?? null;
}

export type CheckState = "missing" | "pending" | "passed" | "failed" | "acceptedWithout";

/** Where a task's check stands, for the badge beside it. */
export function checkStateOf(entry: LoopEntry): CheckState {
  if (entry.acceptedWithoutCheckBy) return "acceptedWithout";
  const latest = latestCheckResult(entry);
  if (latest) return latest.outcome;
  return entry.acceptanceCheck ? "pending" : "missing";
}

export const CHECK_STATE_LABELS: Record<CheckState, string> = {
  missing: "kein Check",
  pending: "Check offen",
  passed: "Check bestanden",
  failed: "Check gescheitert",
  acceptedWithout: "ohne Check abgenommen",
};

/**
 * Why a task may not be done yet, or null. A task is done only once its
 * latest check passed, or once a person accepted it without one. Plans carry
 * checks too, but are not held back by them yet; Inbox items never are.
 */
export function taskDoneBlocker(entry: LoopEntry): string | null {
  if (entry.type !== "task" || entry.inbox !== null) return null;
  if (entry.acceptedWithoutCheckBy) return null;
  const latest = latestCheckResult(entry);
  if (latest?.outcome === "passed") return null;
  if (!entry.acceptanceCheck) {
    return "This task has no acceptance check. Define one with check_define and report its result with check_report; only the user can accept a task without a check.";
  }
  return latest
    ? "The task's check failed last. It is done once check_report reports it passed."
    : "The task's check has not been reported yet. It is done once check_report reports it passed.";
}

export const ACCEPTANCE_CHECK_KIND_LABELS: Record<InitiativeAcceptanceCheck["kind"], string> = {
  command: "Befehl",
  mergedPr: "PR gemergt",
  criterion: "Kriterium",
};

/** The check in one line, for prompts and tool results. */
export function describeCheck(check: InitiativeAcceptanceCheck): string {
  switch (check.kind) {
    case "command":
      return `Run \`${check.ref ?? "?"}\`; it passes when it shows: ${check.expected ?? check.description}. (${check.description})`;
    case "mergedPr":
      return `Pull request ${check.ref ?? "(to be named)"} is merged. (${check.description})`;
    case "criterion":
      return check.description;
  }
}

/** Put ahead of a thread's task prompt: the check its work is measured by. */
export function checkPromptBlock(input: {
  readonly entryId: string;
  readonly check: InitiativeAcceptanceCheck;
}): string {
  return [
    `Acceptance check of this task (entry ${input.entryId}), fixed before you start:`,
    describeCheck(input.check),
    `When you are done, run the check and report its result with check_report (entryId ${input.entryId}) and the evidence: the output excerpt, a link or the commit. "No error occurred" is not a pass.`,
  ].join("\n");
}

/** The message a returned task goes back to its thread with. */
export function returnMessage(input: {
  readonly entryId: string;
  readonly title: string;
  readonly attempt: number;
  readonly finding: string;
  readonly scope: string;
  readonly check: InitiativeAcceptanceCheck | null | undefined;
}): string {
  return [
    `Your task "${input.title}" (entry ${input.entryId}) comes back for correction ${input.attempt} of ${MAX_RETURN_ATTEMPTS}.`,
    `Finding: ${input.finding.trim()}`,
    `Scope: ${input.scope.trim()}`,
    "Change only this, nothing beside it.",
    input.check
      ? `Then run the check again and report it with check_report: ${describeCheck(input.check)}`
      : "Then report the result with check_report once the task has a check.",
  ].join("\n");
}

/** The Inbox question a task raises once its corrections ran out. */
export function escalationQuestion(input: {
  readonly title: string;
  readonly attempts: number;
  readonly finding: string;
}): { readonly title: string; readonly question: string } {
  return {
    title: `Plan prüfen: ${input.title}`.slice(0, 120),
    question: `„${input.title}“ ist nach ${input.attempts} Korrekturen noch nicht abgenommen. Der Fehler liegt vermutlich im Plan, nicht in der Ausführung. Letzter Befund: ${input.finding.trim()}`,
  };
}
