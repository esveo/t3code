const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

// Fork: the coordinator's Inbox, only for sessions granted the "decisions" MCP capability.
const THREAD_DECISIONS_INSTRUCTIONS = `<thread_decisions>
When you need the user to decide or approve something, record each question with upsert_decision instead of numbering questions in a chat message: it stays in the user's Inbox until answered, however many updates arrive, and the answers come back together in one t3_decisions message. When the user has to do something by hand, such as entering a deploy key, record it as a task (kind "task") rather than as a decision; the user checks it off. Withdraw an item that settled itself with resolve_decision, and check what is still open with list_decisions instead of repeating it in chat. In a thread a coordinator started, your items go to the coordinator's Inbox and their answers come to you through the coordinator.
</thread_decisions>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Fork: the session asks for decisions through the Inbox. */
  readonly threadDecisions?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  // Fork: agents name the app esveo code, e.g. in PR attributions.
  return `<runtime_info>In case you're asked: you are running in esveo code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in esveo code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${runtime.threadDecisions ? `\n\n${THREAD_DECISIONS_INSTRUCTIONS}` : ""}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
