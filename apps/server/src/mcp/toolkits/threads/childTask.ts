/**
 * Fork: thread orchestration. The task text a thread started by start_thread
 * receives, before it is wrapped as a message from its coordinator.
 *
 * Coordinators tend to write prompts in English even when the user writes in
 * another language, and a child answers in the language of its prompt. The
 * coordinator therefore names the user's language, and the task says it once;
 * later messages from send_to_thread continue the same conversation, so they
 * do not repeat it.
 */
export function childTaskText(input: {
  readonly prompt: string;
  readonly language?: string | undefined;
}): string {
  const prompt = input.prompt.trim();
  const language = input.language?.replaceAll(/\s+/g, " ").trim();
  if (!language) return prompt;
  return `${prompt}\n\nWrite your answers to the user in ${language}, unless the user asks otherwise. Keep code, commit messages and identifiers in the language the project uses.`;
}
