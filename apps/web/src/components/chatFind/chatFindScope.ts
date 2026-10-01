import type { TimelineEntry } from "../../session-logic";
import { deriveTerminalAssistantMessageIds } from "../chat/MessagesTimeline.logic";

/**
 * Fork: the entries find in thread searches. Of the agent's messages only the
 * last one of each run counts, its actual answer; the commentary it writes
 * while working folds away under "Worked for …" and is left out.
 */
export function chatFindSearchableEntries(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  const answerIds = deriveTerminalAssistantMessageIds(entries);
  return entries.filter(
    (entry) =>
      entry.kind !== "message" ||
      entry.message.role !== "assistant" ||
      answerIds.has(entry.message.id),
  );
}
