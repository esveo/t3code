import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { chatFindSearchableEntries } from "./chatFindScope";

const at = "2026-01-01T00:00:00.000Z";

function message(id: string, role: "user" | "assistant", runId: string | null): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: runId === null ? null : RunId.make(runId),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

describe("chatFindSearchableEntries", () => {
  it("keeps prompts and each run's final answer, dropping commentary", () => {
    const entries = [
      message("u1", "user", "r1"),
      message("a1-commentary", "assistant", "r1"),
      message("a1-answer", "assistant", "r1"),
      message("u2", "user", "r2"),
      message("a2-commentary", "assistant", "r2"),
      message("a2-answer", "assistant", "r2"),
    ];
    expect(chatFindSearchableEntries(entries).map((entry) => entry.id)).toEqual([
      "u1",
      "a1-answer",
      "u2",
      "a2-answer",
    ]);
  });

  it("keeps the last reply per prompt in a thread without runs", () => {
    const entries = [
      message("u1", "user", null),
      message("a1", "assistant", null),
      message("a2", "assistant", null),
      message("u2", "user", null),
      message("a3", "assistant", null),
    ];
    expect(chatFindSearchableEntries(entries).map((entry) => entry.id)).toEqual([
      "u1",
      "a2",
      "u2",
      "a3",
    ]);
  });
});
