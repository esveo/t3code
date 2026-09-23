/**
 * Fork: the state changes of a coordinator's decisions and the message that
 * carries the user's replies. Pure, so the server's store and tools share one
 * definition of what "answered" or "snoozed" means.
 */
import type {
  ThreadDecision,
  ThreadDecisionReply,
  ThreadDecisionUrgency,
  ThreadId,
} from "@t3tools/contracts";

export const DECISIONS_TAG = "t3_decisions";

/** What the coordinator passes to upsert_decision. */
export interface ThreadDecisionInput {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly context?: string | undefined;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly detail?: string | undefined;
    readonly pros?: ReadonlyArray<string> | undefined;
    readonly cons?: ReadonlyArray<string> | undefined;
  }>;
  readonly recommended?:
    | { readonly optionId: string; readonly reason?: string | undefined }
    | undefined;
  readonly urgency?: ThreadDecisionUrgency | undefined;
  readonly sourceThreadId?: ThreadId | undefined;
  readonly routeToThreadId?: ThreadId | undefined;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
}

/** Why the input cannot become a decision, or null when it can. */
export function validateDecisionInput(input: ThreadDecisionInput): string | null {
  if (input.options.length === 0) {
    return "A decision needs at least one option. For a yes/no question pass both.";
  }
  const ids = new Set<string>();
  for (const option of input.options) {
    if (ids.has(option.id)) return `Option id ${option.id} is used twice.`;
    ids.add(option.id);
  }
  if (input.recommended && !ids.has(input.recommended.optionId)) {
    return `The recommended option ${input.recommended.optionId} is not one of the options.`;
  }
  if (input.dependsOn?.includes(input.id)) return "A decision cannot depend on itself.";
  return null;
}

const blankToNull = (value: string | undefined): string | null =>
  value !== undefined && value.trim().length > 0 ? value.trim() : null;

/**
 * Creates the decision or replaces its content. Asking again reopens it: an
 * answered or resolved decision the coordinator upserts is a new question.
 */
export function upsertDecision(
  existing: ThreadDecision | null,
  input: ThreadDecisionInput,
  coordinatorThreadId: ThreadId,
  now: string,
): ThreadDecision {
  return {
    id: input.id,
    coordinatorThreadId,
    title: input.title,
    question: input.question,
    context: blankToNull(input.context),
    options: input.options.map((option) => ({
      id: option.id,
      label: option.label,
      detail: blankToNull(option.detail),
      pros: option.pros ?? [],
      cons: option.cons ?? [],
    })),
    recommendedOptionId: input.recommended?.optionId ?? null,
    recommendationReason: blankToNull(input.recommended?.reason),
    urgency: input.urgency ?? existing?.urgency ?? "today",
    sourceThreadId: input.sourceThreadId ?? null,
    routeToThreadId: input.routeToThreadId ?? null,
    dependsOn: input.dependsOn ?? [],
    status: "open",
    answer: null,
    resolvedReason: null,
    resolvedBy: null,
    snoozedAt: null,
    askedBackAt: existing?.askedBackAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function resolveDecision(
  decision: ThreadDecision,
  reason: string,
  resolvedBy: "coordinator" | "user",
  now: string,
): ThreadDecision {
  return {
    ...decision,
    status: "resolved",
    resolvedReason: blankToNull(reason),
    resolvedBy,
    snoozedAt: null,
    updatedAt: now,
  };
}

/** Snoozing only hides an open decision until the coordinator changes any decision. */
export function snoozeDecision(
  decision: ThreadDecision,
  snoozed: boolean,
  now: string,
): ThreadDecision {
  return { ...decision, snoozedAt: snoozed ? now : null, updatedAt: now };
}

export function reopenDecision(decision: ThreadDecision, now: string): ThreadDecision {
  return {
    ...decision,
    status: "open",
    answer: null,
    resolvedReason: null,
    resolvedBy: null,
    updatedAt: now,
  };
}

/** Whether a reply says anything; an empty one is left out of a submit. */
export function isMeaningfulReply(reply: ThreadDecisionReply): boolean {
  return (
    reply.optionId !== undefined ||
    reply.askBack === true ||
    reply.dismissReason !== undefined ||
    (reply.text?.trim().length ?? 0) > 0
  );
}

/** The decision after the user's reply went out. */
export function applyReply(
  decision: ThreadDecision,
  reply: ThreadDecisionReply,
  now: string,
): ThreadDecision {
  if (reply.dismissReason !== undefined) {
    return resolveDecision(decision, reply.dismissReason, "user", now);
  }
  if (reply.askBack === true) {
    return { ...decision, askedBackAt: now, snoozedAt: null, updatedAt: now };
  }
  return {
    ...decision,
    status: "answered",
    answer: {
      optionId: reply.optionId ?? null,
      text: blankToNull(reply.text),
    },
    snoozedAt: null,
    updatedAt: now,
  };
}

/** Why a reply cannot be sent, or null when it can. */
export function validateReply(
  decision: ThreadDecision | undefined,
  reply: ThreadDecisionReply,
): string | null {
  if (!decision) return `Decision ${reply.decisionId} was not found.`;
  if (decision.status !== "open") return `"${decision.title}" is no longer open.`;
  if (
    reply.optionId !== undefined &&
    !decision.options.some((option) => option.id === reply.optionId)
  ) {
    return `"${decision.title}" has no option ${reply.optionId}.`;
  }
  return null;
}

function describeReply(decision: ThreadDecision, reply: ThreadDecisionReply): string {
  const text = reply.text?.trim() ?? "";
  if (reply.dismissReason !== undefined) {
    const reason = reply.dismissReason.trim();
    return `Dismissed${reason ? `: ${reason}` : "."}`;
  }
  if (reply.askBack === true) {
    return `Asks back: what speaks for and against each option?${text ? ` ${text}` : ""}`;
  }
  const option = decision.options.find((candidate) => candidate.id === reply.optionId);
  if (option) return `Answer: ${option.label} (${option.id})${text ? `. ${text}` : ""}`;
  return `Answer in their own words: ${text}`;
}

/**
 * The message a submit sends to the coordinator: one entry per reply, with
 * the thread the answer is for, so the coordinator can pass it on.
 */
export function formatDecisionReplies(
  entries: ReadonlyArray<{
    readonly decision: ThreadDecision;
    readonly reply: ThreadDecisionReply;
  }>,
  routeLink: (threadId: ThreadId) => string | null,
): string {
  const lines = entries.flatMap(({ decision, reply }) => {
    const route =
      decision.routeToThreadId && reply.askBack !== true && reply.dismissReason === undefined
        ? routeLink(decision.routeToThreadId)
        : null;
    return [
      `- ${decision.id} · ${decision.title}`,
      `  ${describeReply(decision, reply)}`,
      ...(route ? [`  For ${route}: pass it on.`] : []),
    ];
  });
  return [
    `<${DECISIONS_TAG}>`,
    "The user answered in the Inbox:",
    "",
    ...lines,
    `</${DECISIONS_TAG}>`,
  ].join("\n");
}
