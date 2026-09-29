const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

// Fork: the coordinator's Inbox, only for sessions granted the "decisions" MCP capability.
const THREAD_DECISIONS_INSTRUCTIONS = `<thread_decisions>
When you need the user to decide or approve something, record each question with upsert_decision instead of numbering questions in a chat message: it stays in the user's Inbox until answered, however many updates arrive, and the answers come back together in one t3_decisions message. When the user has to do something by hand, such as entering a deploy key, record it as a task (kind "task") rather than as a decision; the user checks it off. Withdraw an item that settled itself with resolve_decision, and check what is still open with list_decisions instead of repeating it in chat. In a thread a coordinator started, your items go to the coordinator's Inbox and their answers come to you through the coordinator.
</thread_decisions>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
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
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${runtime.threadDecisions ? `\n\n${THREAD_DECISIONS_INSTRUCTIONS}` : ""}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
