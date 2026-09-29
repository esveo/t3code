/**
 * The evidence a shadow verdict names, always in the same order: hard results
 * (checks, tests) first, then this run's history, then how often this
 * thread's work was rolled back, and the model's own assessment last, so a
 * model's confidence never outranks what was measured. The evidence informs
 * the record; it does not change the rules' answer. Letting the rollback rate
 * weigh in on an answer belongs to the allowlist step.
 */
import type {
  InitiativeApprovalObservation,
  InitiativeEntry,
  PreflightEvidence,
  PreflightThreadRollbacks,
} from "@t3tools/contracts";

import { answerOf } from "./index.ts";

export const EVIDENCE_ORDER: ReadonlyArray<PreflightEvidence["kind"]> = [
  "hard",
  "run",
  "rollbacks",
  "model",
];

/** The evidence sorted into the fixed order; within a kind it keeps its order. */
export function orderEvidence(
  evidence: ReadonlyArray<PreflightEvidence>,
): ReadonlyArray<PreflightEvidence> {
  return evidence
    .map((item, index) => ({ item, index }))
    .toSorted(
      (a, b) =>
        EVIDENCE_ORDER.indexOf(a.item.kind) - EVIDENCE_ORDER.indexOf(b.item.kind) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

export type EvidenceTask = Pick<
  InitiativeEntry,
  "title" | "status" | "checkResults" | "rolledBackBy"
>;
export type EvidenceObservation = Pick<
  InitiativeApprovalObservation,
  "actionHash" | "resolvedBy" | "decision" | "rolledBackBy"
>;

/**
 * What of a thread's work counts for its rollback rate: requests that were
 * approved (by the user or the provider) and tasks it finished; and how many
 * of those were marked as rolled back.
 */
export function rollbackCount(
  tasks: ReadonlyArray<Pick<InitiativeEntry, "status" | "rolledBackBy">>,
  observations: ReadonlyArray<Pick<InitiativeApprovalObservation, "decision" | "rolledBackBy">>,
): { readonly rolledBack: number; readonly base: number } {
  let rolledBack = 0;
  let base = 0;
  for (const observation of observations) {
    if (answerOf(observation.decision) !== "accept") continue;
    base += 1;
    if (observation.rolledBackBy) rolledBack += 1;
  }
  for (const task of tasks) {
    if (task.status !== "done") continue;
    base += 1;
    if (task.rolledBackBy) rolledBack += 1;
  }
  return { rolledBack, base };
}

/** The evidence behind a verdict on one request of a thread, in the fixed order. */
export function collectEvidence(input: {
  /** The thread's tasks in its initiative. */
  readonly tasks: ReadonlyArray<EvidenceTask>;
  /** The thread's earlier requests in this run, oldest first. */
  readonly earlier: ReadonlyArray<EvidenceObservation>;
  readonly actionHash: string;
  /** What a model checker said about itself; the rules alone have none. */
  readonly modelAssessment?: string | null | undefined;
}): ReadonlyArray<PreflightEvidence> {
  const evidence: Array<PreflightEvidence> = [];

  const checked = input.tasks.flatMap((task) => {
    const latest = task.checkResults?.at(-1);
    return latest ? [`"${task.title}": ${latest.outcome}`] : [];
  });
  evidence.push({
    kind: "hard",
    text:
      checked.length > 0
        ? `Checks of this thread's tasks: ${checked.join("; ")}.`
        : "No check of this thread's tasks has been reported yet.",
  });

  if (input.earlier.length === 0) {
    evidence.push({ kind: "run", text: "The thread's first request in this run." });
  } else {
    let accepted = 0;
    let declined = 0;
    for (const observation of input.earlier) {
      if (observation.resolvedBy !== "person") continue;
      const answer = answerOf(observation.decision);
      if (answer === "accept") accepted += 1;
      else if (answer === "decline") declined += 1;
    }
    const same = input.earlier.findLast(
      (observation) =>
        observation.actionHash === input.actionHash && observation.resolvedBy !== null,
    );
    evidence.push({
      kind: "run",
      text:
        `${input.earlier.length} earlier requests in this run; the user accepted ${accepted} and declined ${declined}.` +
        (same
          ? ` The same action was answered before: ${same.decision ?? "no answer"} (${same.resolvedBy}).`
          : ""),
    });
  }

  const rollbacks = rollbackCount(input.tasks, input.earlier);
  evidence.push({
    kind: "rollbacks",
    text:
      rollbacks.base === 0
        ? "No approved or finished work of this thread yet."
        : `${rollbacks.rolledBack} of ${rollbacks.base} approved requests and finished tasks of this thread were rolled back.`,
  });

  evidence.push({
    kind: "model",
    text: input.modelAssessment?.trim() || "No model assessment: only the fixed rules judged.",
  });
  return orderEvidence(evidence);
}

/**
 * Rollbacks per thread and per provider, from the initiative's requests and
 * tasks. A task counts for its thread's provider; a thread whose provider is
 * not known counts only per thread.
 */
export function rollbackReport(input: {
  readonly observations: ReadonlyArray<
    Pick<InitiativeApprovalObservation, "threadId" | "provider" | "decision" | "rolledBackBy">
  >;
  readonly tasks: ReadonlyArray<
    Pick<InitiativeEntry, "status" | "rolledBackBy" | "threadId" | "type">
  >;
  /** Providers of threads the requests do not name, e.g. from the live thread list. */
  readonly providerOf: (threadId: string) => string | null;
  readonly titleOf?: ((threadId: string) => string | null) | undefined;
}): {
  readonly threads: ReadonlyArray<PreflightThreadRollbacks>;
  readonly byProvider: ReadonlyMap<string, { readonly rolledBack: number; readonly base: number }>;
} {
  const threadIds = new Set<string>();
  const provider = new Map<string, string>();
  for (const observation of input.observations) {
    threadIds.add(observation.threadId);
    provider.set(observation.threadId, observation.provider);
  }
  for (const task of input.tasks) if (task.threadId) threadIds.add(task.threadId);

  const threads: Array<PreflightThreadRollbacks> = [];
  const byProvider = new Map<string, { rolledBack: number; base: number }>();
  for (const threadId of threadIds) {
    const counted = rollbackCount(
      input.tasks.filter((task) => task.type === "task" && task.threadId === threadId),
      input.observations.filter((observation) => observation.threadId === threadId),
    );
    const providerId = provider.get(threadId) ?? input.providerOf(threadId);
    if (providerId) {
      const sum = byProvider.get(providerId) ?? { rolledBack: 0, base: 0 };
      byProvider.set(providerId, {
        rolledBack: sum.rolledBack + counted.rolledBack,
        base: sum.base + counted.base,
      });
    }
    if (counted.rolledBack > 0) {
      threads.push({
        threadId: threadId as PreflightThreadRollbacks["threadId"],
        title: input.titleOf?.(threadId) ?? null,
        provider: providerId,
        ...counted,
      });
    }
  }
  return {
    threads: threads.toSorted((a, b) => b.rolledBack - a.rolledBack),
    byProvider,
  };
}
