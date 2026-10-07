/**
 * Fork: the Claude SDK reports a task started by the Monitor tool as
 * "local_bash", like any background shell; only the launching tool_use names
 * it. Reporting it as "monitor" lets the liveness registry, the agent stage and
 * coordinator updates tell a watch loop from real background work.
 */
export function claudeTaskType(
  taskType: string | undefined,
  launchingToolName: string | undefined,
): string | undefined {
  if (launchingToolName !== "Monitor") return taskType;
  return taskType === undefined || taskType === "local_bash" ? "monitor" : taskType;
}
