import type { SubagentTranscriptEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SUBAGENT_TRANSCRIPT,
  applySubagentTranscriptChunk,
  buildSubagentRelayMessage,
  deriveSubagentChatRows,
} from "./subagentChat.logic";

const entry = (
  id: string,
  kind: SubagentTranscriptEntry["kind"],
  extra: Partial<SubagentTranscriptEntry> = {},
): SubagentTranscriptEntry => ({ id, kind, at: null, text: id, ...extra });

describe("applySubagentTranscriptChunk", () => {
  it("replaces on reset, appends afterwards and skips entries it already holds", () => {
    const first = applySubagentTranscriptChunk(EMPTY_SUBAGENT_TRANSCRIPT, {
      reset: true,
      found: true,
      truncated: false,
      entries: [entry("a", "prompt")],
    });
    const second = applySubagentTranscriptChunk(first, {
      reset: false,
      found: true,
      truncated: false,
      entries: [entry("a", "prompt"), entry("b", "text")],
    });
    expect(second.entries.map((e) => e.id)).toEqual(["a", "b"]);

    const reconnected = applySubagentTranscriptChunk(second, {
      reset: true,
      found: true,
      truncated: true,
      entries: [entry("b", "text")],
    });
    expect(reconnected).toEqual({ found: true, truncated: true, entries: [entry("b", "text")] });
  });
});

describe("deriveSubagentChatRows", () => {
  it("folds each result into its call and keeps orphaned results", () => {
    const rows = deriveSubagentChatRows([
      entry("orphan", "tool_result", { toolUseId: "gone" }),
      entry("call", "tool_use", { toolUseId: "t1", toolName: "Bash" }),
      entry("thinking", "thinking"),
      entry("result", "tool_result", { toolUseId: "t1" }),
      entry("running", "tool_use", { toolUseId: "t2" }),
    ]);
    expect(
      rows.map((row) =>
        row.kind === "tool" ? [row.id, row.call?.id ?? null, row.result?.id ?? null] : [row.id],
      ),
    ).toEqual([
      ["orphan", null, "orphan"],
      ["call", "call", "result"],
      ["thinking"],
      ["running", "running", null],
    ]);
  });
});

describe("buildSubagentRelayMessage", () => {
  it("addresses the agent by id and keeps the text verbatim", () => {
    const message = buildSubagentRelayMessage(
      { id: "a123", title: "Review" },
      "  Check tests too \n",
    );
    expect(message).toContain('to: "a123"');
    expect(message).toContain("<message>\nCheck tests too\n</message>");
  });
});
