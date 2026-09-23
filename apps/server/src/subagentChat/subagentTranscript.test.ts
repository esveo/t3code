import { describe, expect, it } from "vite-plus/test";

import { claudeSessionIdFromResumeCursor } from "./SubagentChat.ts";
import { parseSubagentTranscriptLine, splitTranscriptLines } from "./subagentTranscript.ts";

const line = (record: object) =>
  JSON.stringify({ timestamp: "2026-09-23T10:00:00.000Z", ...record });

describe("parseSubagentTranscriptLine", () => {
  it("reads the prompt, answers, thinking and tool calls in order", () => {
    expect(
      parseSubagentTranscriptLine(
        line({ type: "user", uuid: "u1", message: { role: "user", content: "Find the bug" } }),
      ),
    ).toEqual([{ id: "u1", kind: "prompt", at: "2026-09-23T10:00:00.000Z", text: "Find the bug" }]);

    const assistant = parseSubagentTranscriptLine(
      line({
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "Look at the parser first." },
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "Reading it." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "/repo/src/parse.ts" },
            },
          ],
        },
      }),
    );
    expect(assistant.map((entry) => [entry.id, entry.kind, entry.text])).toEqual([
      ["a1:0", "thinking", "Look at the parser first."],
      ["a1:2", "text", "Reading it."],
      ["a1:3", "tool_use", "/repo/src/parse.ts"],
    ]);
    expect(assistant[2]).toMatchObject({ toolName: "Read", toolUseId: "toolu_1" });
  });

  it("pairs tool results with their call and keeps error results marked", () => {
    expect(
      parseSubagentTranscriptLine(
        line({
          type: "user",
          uuid: "u2",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                is_error: true,
                content: [{ type: "text", text: "ENOENT" }],
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        id: "u2:0",
        kind: "tool_result",
        at: "2026-09-23T10:00:00.000Z",
        text: "ENOENT",
        toolUseId: "toolu_1",
        isError: true,
      },
    ]);
  });

  it("shows messages from the parent and drops harness attachments", () => {
    const coordinator = parseSubagentTranscriptLine(
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
    expect(coordinator).toMatchObject([
      { id: "q1", kind: "prompt", text: "Also check the tests." },
    ]);

    const notification = line({
      type: "attachment",
      uuid: "q2",
      attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>b1</task-id>" },
    });
    const reminder = line({
      type: "attachment",
      uuid: "q3",
      attachment: { type: "total_tokens_reminder" },
    });
    expect(parseSubagentTranscriptLine(notification)).toEqual([]);
    expect(parseSubagentTranscriptLine(reminder)).toEqual([]);
    expect(parseSubagentTranscriptLine("{not json")).toEqual([]);
  });

  it("clamps long tool output", () => {
    const [entry] = parseSubagentTranscriptLine(
      line({
        type: "user",
        uuid: "u3",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(50_000) }],
        },
      }),
    );
    expect(entry!.text.length).toBeLessThan(3_100);
    expect(entry!.text).toContain("more characters");
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
