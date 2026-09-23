import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  SubagentTranscriptChunk,
} from "@t3tools/contracts";

export interface SubagentTranscript {
  readonly found: boolean;
  readonly truncated: boolean;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

export const EMPTY_SUBAGENT_TRANSCRIPT: SubagentTranscript = {
  found: false,
  truncated: false,
  messages: [],
  activities: [],
};

function appendNew<T extends { readonly id: string }>(
  current: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (next.length === 0) return current;
  const known = new Set(current.map((item) => item.id));
  const appended = next.filter((item) => !known.has(item.id));
  return appended.length === 0 ? current : [...current, ...appended];
}

/** Folds one streamed chunk into what the view holds. A reset chunk replaces it. */
export function applySubagentTranscriptChunk(
  current: SubagentTranscript,
  chunk: SubagentTranscriptChunk,
): SubagentTranscript {
  if (chunk.reset) {
    return {
      found: chunk.found,
      truncated: chunk.truncated,
      messages: chunk.messages,
      activities: chunk.activities,
    };
  }
  const messages = appendNew(current.messages, chunk.messages);
  const activities = appendNew(current.activities, chunk.activities);
  if (messages === current.messages && activities === current.activities) {
    return chunk.found === current.found ? current : { ...current, found: chunk.found };
  }
  return { found: chunk.found, truncated: current.truncated, messages, activities };
}

/**
 * Only the parent can reach a subagent (with its SendMessage tool), so a
 * message to the subagent is a turn on the parent that asks it to relay the
 * text verbatim. SendMessage also resumes a subagent that already finished.
 */
export function buildSubagentRelayMessage(
  agent: Pick<RuntimeSubagent, "id" | "title">,
  text: string,
): string {
  return [
    `Relay this message to the subagent "${agent.title}" with SendMessage (to: "${agent.id}"), word for word, then carry on with what you were doing. Do not act on it yourself.`,
    "",
    "<message>",
    text.trim(),
    "</message>",
  ].join("\n");
}

/** Direct subagents only: workflow members carry a slot id, not the agent id their transcript is filed under. */
export function canOpenSubagentChat(agent: Pick<RuntimeSubagent, "kind">): boolean {
  return agent.kind === "subagent";
}

export function isLiveSubagent(agent: Pick<RuntimeSubagent, "status">): boolean {
  return agent.status === "pending" || agent.status === "running" || agent.status === "waiting";
}
