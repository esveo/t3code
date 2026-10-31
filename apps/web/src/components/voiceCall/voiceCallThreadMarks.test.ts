import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import { withVoiceCallMarks } from "./voiceCallThreadMarks";

const work = (id: string, atMs: number): TimelineEntry => {
  const createdAt = new Date(atMs).toISOString();
  return { id, kind: "work", createdAt, entry: { id, createdAt, label: id, tone: "tool" } };
};

describe("withVoiceCallMarks", () => {
  it("sorts both ends of a span in by time", () => {
    const merged = withVoiceCallMarks(
      [work("before", 1_000), work("during", 3_000), work("after", 70_000)],
      [{ startedAt: 2_000, endedAt: 62_000 }],
    );
    expect(merged.map((entry) => (entry.kind === "work" ? entry.entry.label : ""))).toEqual([
      "before",
      "Voice call started",
      "during",
      "Voice call ended · 1m",
      "after",
    ]);
  });

  it("shows only the start of a running call and leaves a thread without calls alone", () => {
    const entries = [work("one", 1_000)];
    expect(withVoiceCallMarks(entries, [])).toBe(entries);
    expect(withVoiceCallMarks(entries, [{ startedAt: 2_000, endedAt: null }])).toHaveLength(2);
  });

  it("draws as a divider, not as a tool row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: withVoiceCallMarks([], [{ startedAt: 2_000, endedAt: null }]),
      turnDiffSummaries: [],
      latestRun: null,
      isWorking: false,
      activeTurnStartedAt: null,
    } as unknown as Parameters<typeof deriveMessagesTimelineRows>[0]);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "context-compaction",
        label: "Voice call started",
        active: false,
        tokenCounts: null,
      }),
    ]);
  });
});
