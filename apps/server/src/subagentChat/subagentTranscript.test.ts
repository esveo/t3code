import { describe, expect, it } from "vite-plus/test";

import { claudeSessionIdFromResumeCursor } from "./SubagentChat.ts";
import { createSubagentTranscriptConverter, splitTranscriptLines } from "./subagentTranscript.ts";

const at = "2026-09-23T10:00:00.000Z";
const line = (record: object) => JSON.stringify({ timestamp: at, ...record });

describe("createSubagentTranscriptConverter", () => {
  it("shows the task and the parent's later messages as user messages", () => {
    const convert = createSubagentTranscriptConverter();
    const task = convert(
      line({ type: "user", uuid: "u1", message: { role: "user", content: "Find the bug" } }),
    );
    const relayed = convert(
      line({
        type: "attachment",
        uuid: "q1",
        attachment: {
          type: "queued_command",
          prompt: "Also check the tests.",
          origin: { kind: "coordinator" },
        },
      }),
    );
    expect([...task.messages, ...relayed.messages].map((m) => [m.role, m.text])).toEqual([
      ["user", "Find the bug"],
      ["user", "Also check the tests."],
    ]);
  });

  it("maps answers and thinking to assistant and reasoning messages", () => {
    const convert = createSubagentTranscriptConverter();
    const { messages } = convert(
      line({
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "Look at the parser first." },
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "Reading it." },
          ],
        },
      }),
    );
    expect(messages.map((m) => [m.id, m.role, m.text])).toEqual([
      ["subagent:a1:0", "reasoning", "Look at the parser first."],
      ["subagent:a1:2", "assistant", "Reading it."],
    ]);
  });

  it("completes a tool call with its result, as the parent's timeline does", () => {
    const convert = createSubagentTranscriptConverter();
    const started = convert(
      line({
        type: "assistant",
        uuid: "a2",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      }),
    );
    const completed = convert(
      line({
        type: "user",
        uuid: "u2",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "ENOENT" },
          ],
        },
      }),
    );
    expect(started.activities).toMatchObject([
      {
        kind: "tool.started",
        payload: { itemType: "command_execution", toolCallId: "toolu_1", status: "inProgress" },
      },
    ]);
    expect(completed.activities).toMatchObject([
      {
        kind: "tool.completed",
        payload: { toolCallId: "toolu_1", status: "failed", detail: "Bash: ls -la" },
      },
    ]);
  });

  it("drops harness notifications and unreadable lines", () => {
    const convert = createSubagentTranscriptConverter();
    const dropped = [
      line({
        type: "attachment",
        uuid: "q2",
        attachment: {
          type: "queued_command",
          prompt: "<task-notification>\n<task-id>b1</task-id>",
        },
      }),
      line({ type: "attachment", uuid: "q3", attachment: { type: "total_tokens_reminder" } }),
      "{not json",
    ].map(convert);
    expect(dropped.every((slice) => slice.messages.length + slice.activities.length === 0)).toBe(
      true,
    );
  });
});

describe("splitTranscriptLines", () => {
  it("carries a line the harness is still writing into the next read", () => {
    expect(splitTranscriptLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    });
    expect(splitTranscriptLines('{"c"')).toEqual({ lines: [], rest: '{"c"' });
  });
});

describe("claudeSessionIdFromResumeCursor", () => {
  it("reads the session from either cursor shape and rejects anything else", () => {
    const id = "0889d315-fa6f-4345-b9c7-b5a983dfb761";
    expect(claudeSessionIdFromResumeCursor({ resume: id })).toBe(id);
    expect(claudeSessionIdFromResumeCursor({ sessionId: id })).toBe(id);
    expect(claudeSessionIdFromResumeCursor({ resume: "../../etc" })).toBeUndefined();
    expect(claudeSessionIdFromResumeCursor(null)).toBeUndefined();
  });
});
