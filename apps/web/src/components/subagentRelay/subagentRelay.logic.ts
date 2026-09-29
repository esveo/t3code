/**
 * Only the parent can reach a provider subagent (Claude: with its SendMessage
 * tool), so a message to the subagent is a turn on the parent. The parent is
 * responsible for its subagent, so it may add context rather than relay
 * verbatim. SendMessage also resumes a subagent that already finished.
 */
export function buildSubagentRelayMessage(
  agent: { readonly agentId: string; readonly title: string | null },
  text: string,
): string {
  const name = agent.title === null ? "your subagent" : `your subagent "${agent.title}"`;
  return [
    `The user sent this to ${name} (id: ${agent.agentId}). Pass it on with SendMessage, adding context where it helps and keeping what the user asked for:`,
    "",
    "<message>",
    text.trim(),
    "</message>",
  ].join("\n");
}
