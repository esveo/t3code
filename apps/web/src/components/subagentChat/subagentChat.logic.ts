import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type { SubagentTranscriptChunk, SubagentTranscriptEntry } from "@t3tools/contracts";

export interface SubagentTranscript {
  readonly found: boolean;
  readonly truncated: boolean;
  readonly entries: ReadonlyArray<SubagentTranscriptEntry>;
}

export const EMPTY_SUBAGENT_TRANSCRIPT: SubagentTranscript = {
  found: false,
  truncated: false,
  entries: [],
};

/** Folds one streamed chunk into what the view holds. A reset chunk replaces it. */
export function applySubagentTranscriptChunk(
  current: SubagentTranscript,
  chunk: SubagentTranscriptChunk,
): SubagentTranscript {
  if (chunk.reset) {
    return { found: chunk.found, truncated: chunk.truncated, entries: chunk.entries };
  }
  if (chunk.entries.length === 0) {
    return chunk.found === current.found ? current : { ...current, found: chunk.found };
  }
  const known = new Set(current.entries.map((entry) => entry.id));
  const appended = chunk.entries.filter((entry) => !known.has(entry.id));
  return {
    found: chunk.found,
    truncated: current.truncated,
    entries: appended.length === 0 ? current.entries : [...current.entries, ...appended],
  };
}

export type SubagentChatRow =
  | {
      readonly kind: "prompt" | "text" | "thinking";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly call: SubagentTranscriptEntry | null;
      readonly result: SubagentTranscriptEntry | null;
    };

/**
 * Rows in reading order: every tool call carries its result, and a result
 * whose call fell outside the loaded window stands alone.
 */
export function deriveSubagentChatRows(
  entries: ReadonlyArray<SubagentTranscriptEntry>,
): ReadonlyArray<SubagentChatRow> {
  const calls = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "tool_use" && entry.toolUseId) calls.add(entry.toolUseId);
  }
  const results = new Map<string, SubagentTranscriptEntry>();
  for (const entry of entries) {
    if (entry.kind === "tool_result" && entry.toolUseId && calls.has(entry.toolUseId)) {
      results.set(entry.toolUseId, entry);
    }
  }
  return entries.flatMap((entry): SubagentChatRow[] => {
    switch (entry.kind) {
      case "tool_use":
        return [
          {
            kind: "tool",
            id: entry.id,
            call: entry,
            result: (entry.toolUseId && results.get(entry.toolUseId)) || null,
          },
        ];
      case "tool_result":
        return entry.toolUseId && calls.has(entry.toolUseId)
          ? []
          : [{ kind: "tool", id: entry.id, call: null, result: entry }];
      default:
        return [{ kind: entry.kind, id: entry.id, text: entry.text }];
    }
  });
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
