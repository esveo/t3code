/**
 * Fork: what the Inbox tab shows of a coordinator's decisions and what it
 * sends back. Replies are drafts on the client until the user sends them all
 * together, so a reply can still change while other questions come in.
 */
import type {
  ThreadDecision,
  ThreadDecisionReply,
  ThreadDecisionUrgency,
  ThreadId,
} from "@t3tools/contracts";

/** A reply the user has started but not sent. */
export interface DecisionDraft {
  readonly optionId?: string | undefined;
  readonly text?: string | undefined;
  readonly askBack?: boolean | undefined;
  readonly dismissReason?: string | undefined;
}

export type InboxGroupBy = "urgency" | "thread";

export const URGENCY_LABELS: Record<ThreadDecisionUrgency, string> = {
  now: "Now",
  today: "Today",
  later: "Can wait",
};

const URGENCY_RANK: Record<ThreadDecisionUrgency, number> = { now: 0, today: 1, later: 2 };

export const isSnoozed = (decision: ThreadDecision) => decision.snoozedAt !== null;

/** Open and not snoozed: what waits on the user right now. */
export const isWaiting = (decision: ThreadDecision) =>
  decision.status === "open" && !isSnoozed(decision);

export function waitingDecisionCount(decisions: ReadonlyArray<ThreadDecision>): number {
  return decisions.filter(isWaiting).length;
}

/**
 * The waiting decisions in the order to answer them: most urgent first, and
 * each after the decisions it depends on, so a follow-up question never comes
 * before what it builds on.
 */
export function orderDecisions(
  decisions: ReadonlyArray<ThreadDecision>,
): ReadonlyArray<ThreadDecision> {
  const waiting = decisions
    .filter(isWaiting)
    .toSorted((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
  const byId = new Map(waiting.map((decision) => [decision.id, decision]));
  const ordered: ThreadDecision[] = [];
  const visiting = new Set<string>();
  const add = (decision: ThreadDecision) => {
    if (ordered.includes(decision) || visiting.has(decision.id)) return;
    visiting.add(decision.id);
    for (const dependencyId of decision.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) add(dependency);
    }
    ordered.push(decision);
  };
  waiting.forEach(add);
  return ordered;
}

export interface InboxGroup {
  readonly id: string;
  readonly label: string;
  readonly decisions: ReadonlyArray<ThreadDecision>;
}

/** Groups keep the answer order within them; empty groups are left out. */
export function groupDecisions(
  ordered: ReadonlyArray<ThreadDecision>,
  groupBy: InboxGroupBy,
  threadTitle: (threadId: ThreadId) => string | null,
  coordinatorTitle: string,
): ReadonlyArray<InboxGroup> {
  if (groupBy === "urgency") {
    return (["now", "today", "later"] as const)
      .map((urgency) => ({
        id: urgency,
        label: URGENCY_LABELS[urgency],
        decisions: ordered.filter((decision) => decision.urgency === urgency),
      }))
      .filter((group) => group.decisions.length > 0);
  }
  const groups = new Map<string, ThreadDecision[]>();
  for (const decision of ordered) {
    const key = decision.sourceThreadId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), decision]);
  }
  return [...groups].map(([key, decisions]) => ({
    id: key || "coordinator",
    label: key ? (threadTitle(key as ThreadId) ?? "Thread") : coordinatorTitle,
    decisions,
  }));
}

/** The next decision without a draft after the current one, wrapping around. */
export function nextUndrafted(
  ordered: ReadonlyArray<ThreadDecision>,
  currentId: string | null,
  drafts: Readonly<Record<string, DecisionDraft>>,
): ThreadDecision | null {
  const index = ordered.findIndex((decision) => decision.id === currentId);
  const undrafted = (decision: ThreadDecision) =>
    decision.id !== currentId && !hasDraft(drafts[decision.id]);
  return (
    ordered.slice(index + 1).find(undrafted) ??
    ordered.find(undrafted) ??
    ordered[index + 1] ??
    null
  );
}

export function hasDraft(draft: DecisionDraft | undefined): boolean {
  if (!draft) return false;
  return (
    draft.optionId !== undefined ||
    draft.askBack === true ||
    draft.dismissReason !== undefined ||
    (draft.text?.trim().length ?? 0) > 0
  );
}

export function draftToReply(decisionId: string, draft: DecisionDraft): ThreadDecisionReply | null {
  if (!hasDraft(draft)) return null;
  const text = draft.text?.trim();
  return {
    decisionId,
    ...(draft.optionId !== undefined ? { optionId: draft.optionId } : {}),
    ...(text ? { text } : {}),
    ...(draft.askBack ? { askBack: true } : {}),
    ...(draft.dismissReason !== undefined ? { dismissReason: draft.dismissReason } : {}),
  };
}

/** How the outbox shows a draft, in the user's own words. */
export function describeDraft(decision: ThreadDecision, draft: DecisionDraft): string {
  const text = draft.text?.trim() ?? "";
  if (draft.dismissReason !== undefined) {
    return draft.dismissReason.trim() ? `Done: ${draft.dismissReason.trim()}` : "Done";
  }
  if (draft.askBack) return text ? `Asks back: ${text}` : "Asks for pros and cons";
  const option = decision.options.find((candidate) => candidate.id === draft.optionId);
  if (option) return text ? `${option.label} – ${text}` : option.label;
  return text;
}

/** How the done section shows a decision that left the waiting list. */
export function describeSettled(decision: ThreadDecision): string {
  if (decision.status === "resolved") {
    const by = decision.resolvedBy === "user" ? "Done" : "Withdrawn";
    return decision.resolvedReason ? `${by}: ${decision.resolvedReason}` : by;
  }
  if (decision.status === "answered" && decision.answer) {
    const option = decision.options.find((candidate) => candidate.id === decision.answer?.optionId);
    return [option?.label, decision.answer.text].filter((part) => part).join(" – ") || "Answered";
  }
  return "Snoozed until the coordinator's next update";
}
