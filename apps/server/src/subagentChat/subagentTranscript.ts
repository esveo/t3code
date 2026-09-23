/**
 * Fork: turns lines of a Claude subagent transcript
 * (`<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`) into the
 * entries the subagent chat view renders. Pure, so tailing and tests share it.
 *
 * Only what reads as conversation survives: the prompt, messages the parent
 * sent mid-run (queued commands from the coordinator), answers, thinking, tool
 * calls and their results. Harness attachments (reminders, listings, task
 * notifications) are dropped.
 */
import {
  SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH,
  SUBAGENT_TRANSCRIPT_TOOL_INPUT_MAX_LENGTH,
  SUBAGENT_TRANSCRIPT_TOOL_RESULT_MAX_LENGTH,
  type SubagentTranscriptEntry,
} from "@t3tools/contracts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
    : text;
}

/** A tool result's content is a string or an array of text/image blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** One line for the collapsed tool row: the input field that says the most. */
function summarizeToolInput(input: Json): string {
  for (const key of [
    "description",
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().split("\n")[0]!.slice(0, 200);
    }
  }
  return "";
}

function stringifyInput(input: unknown): string | undefined {
  if (!isRecord(input) || Object.keys(input).length === 0) return undefined;
  try {
    return clamp(JSON.stringify(input, null, 2), SUBAGENT_TRANSCRIPT_TOOL_INPUT_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

export function parseSubagentTranscriptLine(line: string): ReadonlyArray<SubagentTranscriptEntry> {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(record)) return [];
  const uuid = typeof record.uuid === "string" ? record.uuid : null;
  if (uuid === null) return [];
  const at = typeof record.timestamp === "string" ? record.timestamp : null;

  if (record.type === "attachment") {
    const attachment = record.attachment;
    if (!isRecord(attachment) || attachment.type !== "queued_command") return [];
    const prompt = typeof attachment.prompt === "string" ? attachment.prompt : "";
    if (prompt.length === 0 || prompt.startsWith("<task-notification>")) return [];
    return [
      { id: uuid, kind: "prompt", at, text: clamp(prompt, SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH) },
    ];
  }

  const message = record.message;
  if (!isRecord(message)) return [];
  const content = message.content;

  if (record.type === "user") {
    if (typeof content === "string") {
      return content.trim().length === 0
        ? []
        : [
            {
              id: uuid,
              kind: "prompt",
              at,
              text: clamp(content, SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH),
            },
          ];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((block, index): SubagentTranscriptEntry[] => {
      if (!isRecord(block)) return [];
      const id = `${uuid}:${index}`;
      if (block.type === "tool_result") {
        return [
          {
            id,
            kind: "tool_result",
            at,
            text: clamp(toolResultText(block.content), SUBAGENT_TRANSCRIPT_TOOL_RESULT_MAX_LENGTH),
            ...(typeof block.tool_use_id === "string" ? { toolUseId: block.tool_use_id } : {}),
            ...(block.is_error === true ? { isError: true } : {}),
          },
        ];
      }
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        return [
          { id, kind: "prompt", at, text: clamp(block.text, SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH) },
        ];
      }
      return [];
    });
  }

  if (record.type === "assistant" && Array.isArray(content)) {
    return content.flatMap((block, index): SubagentTranscriptEntry[] => {
      if (!isRecord(block)) return [];
      const id = `${uuid}:${index}`;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        return [
          { id, kind: "text", at, text: clamp(block.text, SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH) },
        ];
      }
      // Thinking without text is a signature-only block; nothing to read.
      if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim().length > 0
      ) {
        return [
          {
            id,
            kind: "thinking",
            at,
            text: clamp(block.thinking, SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH),
          },
        ];
      }
      if (
        (block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use") &&
        typeof block.name === "string"
      ) {
        const input = isRecord(block.input) ? block.input : {};
        const serializedInput = stringifyInput(input);
        return [
          {
            id,
            kind: "tool_use",
            at,
            text: summarizeToolInput(input),
            toolName: block.name,
            ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
            ...(serializedInput ? { input: serializedInput } : {}),
          },
        ];
      }
      return [];
    });
  }

  return [];
}

/**
 * Splits a chunk read from the file into complete lines. The last element is
 * the unterminated remainder, carried into the next read: the harness can be
 * mid-write when we read.
 */
export function splitTranscriptLines(buffered: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const lastNewline = buffered.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], rest: buffered };
  return {
    lines: buffered
      .slice(0, lastNewline)
      .split("\n")
      .filter((line) => line.length > 0),
    rest: buffered.slice(lastNewline + 1),
  };
}
