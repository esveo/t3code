/**
 * Fork: the progress line of a running Claude subagent.
 *
 * Claude reports a `task_progress` for every tool a subagent starts
 * ("Running npm test") and, with `agentProgressSummaries`, a short summary of
 * its work about every 30 seconds. A background subagent keeps working after
 * its parent's turn ended; from then on the adapter holds its frames for the
 * wake replay and drops its `task_progress`, so its thread would show nothing
 * but "Thinking" until it finishes. Its progress line goes out right away
 * instead.
 *
 * @module ClaudeSubagentProgress
 */
import type { SDKTaskProgressMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import type { DateTime } from "effect";

/** The line a `task_progress` shows: the summary when Claude wrote one, else the tool it started. */
export function claudeTaskProgressText(
  message: Pick<SDKTaskProgressMessage, "description" | "summary">,
): string {
  return message.summary?.trim() || message.description.trim();
}

/**
 * The subagent with a progress line that arrived while its parent was idle,
 * or null when there is nothing to publish: an unknown or settled subagent,
 * an empty line, or the line it already shows.
 */
export function subagentWithIdleProgress(
  subagent: OrchestrationV2Subagent | undefined,
  progress: string,
  now: DateTime.Utc,
): OrchestrationV2Subagent | null {
  if (subagent === undefined || subagent.status !== "running") return null;
  if (progress.length === 0 || subagent.progress === progress) return null;
  return { ...subagent, progress, updatedAt: now };
}
