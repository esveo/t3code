import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import { EventId, MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SUBAGENT_TRANSCRIPT,
  applySubagentTranscriptChunk,
  buildSubagentRelayMessage,
} from "./subagentChat.logic";

const at = "2026-09-23T10:00:00.000Z";
const message = (id: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text: id,
  turnId: null,
  streaming: false,
  createdAt: at,
  updatedAt: at,
});
const activity = (id: string): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind: "tool.started",
  summary: "Command run started",
  payload: {},
  turnId: null,
  createdAt: at,
});

describe("applySubagentTranscriptChunk", () => {
  it("replaces on reset, appends afterwards and skips rows it already holds", () => {
    const first = applySubagentTranscriptChunk(EMPTY_SUBAGENT_TRANSCRIPT, {
      reset: true,
      found: true,
      truncated: false,
      messages: [message("a")],
      activities: [],
    });
    const second = applySubagentTranscriptChunk(first, {
      reset: false,
      found: true,
      truncated: false,
      messages: [message("a"), message("b")],
      activities: [activity("t1")],
    });
    expect(second.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(second.activities.map((a) => a.id)).toEqual(["t1"]);

    const unchanged = applySubagentTranscriptChunk(second, {
      reset: false,
      found: true,
      truncated: false,
      messages: [message("b")],
      activities: [],
    });
    expect(unchanged).toBe(second);

    const reconnected = applySubagentTranscriptChunk(second, {
      reset: true,
      found: true,
      truncated: true,
      messages: [message("b")],
      activities: [],
    });
    expect(reconnected.messages.map((m) => m.id)).toEqual(["b"]);
    expect(reconnected.truncated).toBe(true);
  });
});

describe("buildSubagentRelayMessage", () => {
  it("names the agent by id and quotes the user's text", () => {
    const text = buildSubagentRelayMessage({ id: "a123", title: "Review" }, "  Check tests too \n");
    expect(text).toContain('"Review" (id: a123)');
    expect(text).toContain("<message>\nCheck tests too\n</message>");
  });
});
