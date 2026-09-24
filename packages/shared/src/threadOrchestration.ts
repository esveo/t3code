/**
 * Fork: thread orchestration. A coordinator thread starts child threads
 * (`parentThreadId`) and follows them. The server's thread tools and the
 * client's overview both read a child's state from its shell through these
 * helpers, so the agent and the user see the same word for the same thread.
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type ChildThreadState = "waiting" | "failed" | "working" | "review" | "stopped" | "done";

type ChildThreadShell = Pick<
  OrchestrationThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
  | "pullRequests"
  | "planProgress"
  | "backgroundLiveness"
>;

/** Open pull requests of the thread, newest link first. */
function openPullRequests(thread: ChildThreadShell) {
  const open = thread.pullRequests.filter(
    (link) => link.snapshot === null || link.snapshot.state === "open",
  );
  return open.map((_, index) => open[open.length - 1 - index]!);
}

/**
 * Waiting beats everything: a question or approval blocks the thread. A thread
 * whose turn ended while its subagents, background commands or monitors still
 * run is working: the provider wakes the agent when they report back. A thread
 * with an open pull request and nothing running is ready for review.
 */
export function resolveChildThreadState(thread: ChildThreadShell): ChildThreadState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null
  ) {
    return "working";
  }
  if (openPullRequests(thread).length > 0) return "review";
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt === null) {
    return "stopped";
  }
  return "done";
}

export const CHILD_THREAD_STATE_LABELS: Record<ChildThreadState, string> = {
  waiting: "Waiting on you",
  failed: "Failed",
  working: "Working",
  review: "Ready for review",
  stopped: "Stopped",
  done: "Done",
};

/** One line on what the thread is doing or what it needs, next to its state. */
export function describeChildThread(thread: ChildThreadShell): string {
  const state = resolveChildThreadState(thread);
  switch (state) {
    case "waiting":
      return thread.hasPendingApprovals ? "Needs your approval" : "Has a question for you";
    case "failed":
      return thread.session?.lastError?.split("\n")[0]?.slice(0, 160) ?? "The last turn failed";
    case "working":
      if (thread.planProgress) return thread.planProgress.step;
      if (thread.session?.status === "starting") return "Setting up";
      if (thread.session?.status !== "running" && thread.latestTurn?.state !== "running") {
        if (thread.backgroundLiveness === "working") return "Waiting on its subagents";
        if (thread.backgroundLiveness === "monitoring") return "Waiting on background commands";
      }
      return "Working";
    case "review": {
      const pullRequest = openPullRequests(thread)[0]!;
      return pullRequest.snapshot?.isDraft
        ? `Draft PR #${pullRequest.number}`
        : `PR #${pullRequest.number} open`;
    }
    case "stopped":
      return "Stopped before it finished";
    case "done":
      return "Finished";
  }
}

/** Todo progress of the running turn, when the agent keeps a task list. */
export function childThreadProgress(
  thread: ChildThreadShell,
): { readonly completed: number; readonly total: number } | null {
  const progress = thread.planProgress;
  if (!progress || progress.totalSteps === 0) return null;
  return { completed: progress.completedSteps, total: progress.totalSteps };
}

/**
 * Markdown link a coordinator writes to mention a child thread. The client
 * renders it as a chip with the thread's live state.
 */
export const THREAD_LINK_SCHEME = "t3-thread:";

export function threadLinkHref(threadId: string): string {
  return `${THREAD_LINK_SCHEME}${threadId}`;
}

export function parseThreadLinkHref(href: string): string | null {
  if (!href.startsWith(THREAD_LINK_SCHEME)) return null;
  const threadId = href.slice(THREAD_LINK_SCHEME.length).replace(/^\/+/, "").trim();
  return threadId.length > 0 ? threadId : null;
}

/**
 * Tags that mark messages between a coordinator and its children. The agents
 * read them as provenance; the client renders them as labels instead of text.
 */
export const FROM_COORDINATOR_TAG = "t3_from_coordinator";
export const THREAD_UPDATE_TAG = "t3_thread_update";

export function wrapFromCoordinator(input: {
  readonly coordinatorThreadId: string;
  readonly coordinatorTitle: string;
  readonly text: string;
}): string {
  return [
    `<${FROM_COORDINATOR_TAG} thread_id="${input.coordinatorThreadId}" title="${escapeAttribute(input.coordinatorTitle)}">`,
    input.text.trim(),
    `</${FROM_COORDINATOR_TAG}>`,
  ].join("\n");
}

export function wrapThreadUpdate(input: {
  readonly threadId: string;
  readonly title: string;
  readonly state: ChildThreadState;
  readonly detail: string;
  readonly text: string;
}): string {
  return [
    `<${THREAD_UPDATE_TAG} thread_id="${input.threadId}" title="${escapeAttribute(input.title)}" state="${input.state}" detail="${escapeAttribute(input.detail)}">`,
    input.text.trim(),
    `</${THREAD_UPDATE_TAG}>`,
  ].join("\n");
}

export interface TaggedThreadMessage {
  readonly tag: typeof FROM_COORDINATOR_TAG | typeof THREAD_UPDATE_TAG;
  readonly threadId: string;
  readonly title: string;
  readonly state: ChildThreadState | null;
  readonly detail: string | null;
  readonly body: string;
}

const TAGGED_MESSAGE_PATTERN = new RegExp(
  `^<(${FROM_COORDINATOR_TAG}|${THREAD_UPDATE_TAG})((?:\\s+[a-z_]+="[^"]*")*)>\\n?([\\s\\S]*?)\\n?</\\1>\\s*$`,
);
const ATTRIBUTE_PATTERN = /([a-z_]+)="([^"]*)"/g;
const CHILD_THREAD_STATES = new Set<string>(Object.keys(CHILD_THREAD_STATE_LABELS));

export function parseTaggedThreadMessage(text: string): TaggedThreadMessage | null {
  const match = TAGGED_MESSAGE_PATTERN.exec(text.trim());
  // Several update blocks in one message are a bundle: parseThreadUpdates.
  if (!match || match[3]!.includes(`</${match[1]}>`)) return null;
  const attributes = new Map<string, string>();
  for (const [, name, value] of match[2]!.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(name!, unescapeAttribute(value!));
  }
  const threadId = attributes.get("thread_id");
  if (!threadId) return null;
  const state = attributes.get("state") ?? null;
  return {
    tag: match[1] as TaggedThreadMessage["tag"],
    threadId,
    title: attributes.get("title") ?? "",
    state: state !== null && CHILD_THREAD_STATES.has(state) ? (state as ChildThreadState) : null,
    detail: attributes.get("detail") ?? null,
    body: match[3] ?? "",
  };
}

const THREAD_UPDATE_BLOCK_PATTERN = new RegExp(
  `<${THREAD_UPDATE_TAG}(?:\\s+[a-z_]+="[^"]*")*>[\\s\\S]*?</${THREAD_UPDATE_TAG}>`,
  "g",
);

/**
 * The child updates of a coordinator message: one, or several that arrived
 * together as one turn. Null for any other message.
 */
export function parseThreadUpdates(text: string): ReadonlyArray<TaggedThreadMessage> | null {
  const blocks = text.match(THREAD_UPDATE_BLOCK_PATTERN);
  if (!blocks || text.replace(THREAD_UPDATE_BLOCK_PATTERN, "").trim() !== "") return null;
  const updates = blocks.map(parseTaggedThreadMessage);
  return updates.every((update) => update !== null) ? updates : null;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("\n", " ");
}

function unescapeAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

/** A tagged message as one line of plain text, for previews that cannot render the card. */
export function plainTextOfThreadMessage(text: string): string {
  const tagged = parseTaggedThreadMessage(text);
  if (!tagged) {
    const updates = parseThreadUpdates(text);
    return updates ? updates.map((update) => plainTextOfUpdate(update)).join("; ") : text;
  }
  if (tagged.tag === FROM_COORDINATOR_TAG) return tagged.body;
  return plainTextOfUpdate(tagged);
}

function plainTextOfUpdate(tagged: TaggedThreadMessage): string {
  const state = tagged.state ? CHILD_THREAD_STATE_LABELS[tagged.state] : null;
  return [tagged.title, state, tagged.detail].filter(Boolean).join(" · ");
}

/**
 * A tagged message as Markdown for clients without the dedicated rendering:
 * who sent it or which thread it reports on, then its text.
 */
export function readableThreadMessage(text: string): string {
  const tagged = parseTaggedThreadMessage(text);
  if (tagged?.tag === FROM_COORDINATOR_TAG) {
    return tagged.title ? `_From ${tagged.title}_\n\n${tagged.body}` : tagged.body;
  }
  const updates = tagged ? [tagged] : parseThreadUpdates(text);
  if (!updates) return text;
  return updates.map((update) => `**${plainTextOfUpdate(update)}**\n\n${update.body}`).join("\n\n");
}
