import { describe, expect, it } from "vite-plus/test";

import { claudeSessionMeta, claudeTranscriptExcerpt, codexTranscriptExcerpt } from "./index.ts";

const line = (record: Record<string, unknown>) => JSON.stringify(record);

const transcript = [
  line({ type: "queue-operation", sessionId: "s1" }),
  line({
    type: "user",
    sessionId: "s1",
    cwd: "/Users/robert/dev/relaunch",
    gitBranch: "main",
    entrypoint: "claude-desktop",
    timestamp: "2026-09-20T10:00:00.000Z",
    message: { role: "user", content: "<system-reminder>ignore</system-reminder>" },
  }),
  line({
    type: "user",
    sessionId: "s1",
    cwd: "/Users/robert/dev/relaunch",
    timestamp: "2026-09-20T10:00:05.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "Bau die Startseite neu, API_KEY=geheim" }],
    },
  }),
  line({
    type: "assistant",
    sessionId: "s1",
    cwd: "/Users/robert/dev/relaunch",
    gitBranch: "feature/start",
    timestamp: "2026-09-20T11:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus",
      content: [{ type: "text", text: "Fertig." }],
    },
  }),
  "not json",
];

describe("claudeSessionMeta", () => {
  it("reads folder, time, branch, entrypoint and the first real prompt as title", () => {
    expect(claudeSessionMeta(transcript, "file-id")).toMatchObject({
      source: "claude-desktop",
      nativeId: "s1",
      cwd: "/Users/robert/dev/relaunch",
      startedAt: "2026-09-20T10:00:00.000Z",
      endedAt: "2026-09-20T11:00:00.000Z",
      branch: "feature/start",
      model: "claude-opus",
      title: "Bau die Startseite neu, API_KEY=geheim",
    });
  });

  it("prefers the custom title", () => {
    expect(
      claudeSessionMeta(
        [...transcript, line({ type: "custom-title", customTitle: "Startseite" })],
        "f",
      )?.title,
    ).toBe("Startseite");
  });

  it("gives no session for a file without messages", () => {
    expect(claudeSessionMeta([line({ type: "queue-operation" })], "f")).toBeNull();
  });
});

describe("excerpts", () => {
  it("keeps the prompt and answers and masks secrets", () => {
    const excerpt = claudeTranscriptExcerpt(transcript);
    expect(excerpt).toContain("User: Bau die Startseite neu, API_KEY=***");
    expect(excerpt).toContain("Agent: Fertig.");
    expect(excerpt).not.toContain("geheim");
    expect(excerpt).not.toContain("system-reminder");
  });

  it("reads Codex rollouts", () => {
    const excerpt = codexTranscriptExcerpt([
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the build" }],
        },
      }),
      line({
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "Build is green." },
      }),
    ]);
    expect(excerpt).toBe("User: Fix the build\n\nAgent: Build is green.");
  });
});
