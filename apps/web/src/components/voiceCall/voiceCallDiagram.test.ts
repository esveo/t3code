import { describe, expect, it } from "vite-plus/test";

import {
  speechBounds,
  voiceCallBars,
  voiceCallCaption,
  voiceCallPills,
  voiceCallSpeechSpans,
} from "./voiceCallDiagram";

const levels = (loud: ReadonlyArray<number>) => (bucket: number) =>
  loud.includes(bucket) ? 0.5 : 0;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("voiceCallPills", () => {
  const block = (stepStarts: ReadonlyArray<number>) => ({
    startedAt: 100,
    endedAt: null,
    stepStarts,
    failed: false,
    messageId: null,
  });

  it("gives work without steps one pill", () => {
    expect(voiceCallPills(block([]), 300)).toEqual([{ startedAt: 100, endedAt: 300 }]);
  });

  it("ends each step where the next starts, in time order", () => {
    expect(voiceCallPills(block([200, 150]), 300)).toEqual([
      { startedAt: 100, endedAt: 150 },
      { startedAt: 150, endedAt: 200 },
      { startedAt: 200, endedAt: 300 },
    ]);
  });
});

describe("voiceCallBars", () => {
  const buckets = (loud: ReadonlyArray<number>) =>
    voiceCallBars(levels(loud), 0, 20).map((bar) => bar.bucket);

  it("closes short dips inside speech", () => {
    expect(buckets([1, 2, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("leaves real pauses and the silence around speech empty", () => {
    expect(buckets([1, 6])).toEqual([1, 6]);
  });
});

describe("voiceCallSpeechSpans", () => {
  it("matches each turn to its own audio, although the events arrive late", () => {
    const spans = voiceCallSpeechSpans(
      levels([...range(10, 20), ...range(60, 80)]),
      [
        { turnId: "a", startedAt: 15 * 125, endedAt: 22 * 125 },
        { turnId: "b", startedAt: 65 * 125, endedAt: 75 * 125 },
      ],
      0,
      100,
    );
    expect(spans).toEqual([
      { turnId: "a", first: 10, last: 20 },
      { turnId: "b", first: 60, last: 80 },
    ]);
  });
});

describe("speechBounds", () => {
  it("starts where the speech started, not where the late event arrived", () => {
    const bounds = speechBounds(levels(range(90, 110)), {
      start: 100,
      end: 112,
      floor: 0,
      ceiling: 200,
    });
    expect(bounds).toEqual({ first: 90, last: 110 });
  });

  it("does not reach into the turn before it", () => {
    const bounds = speechBounds(levels(range(90, 110)), {
      start: 100,
      end: 110,
      floor: 96,
      ceiling: 200,
    });
    expect(bounds.first).toBe(96);
  });

  it("waits for the first loud bar after an early event", () => {
    const bounds = speechBounds(levels(range(120, 130)), {
      start: 100,
      end: 135,
      floor: 0,
      ceiling: 200,
    });
    expect(bounds).toEqual({ first: 120, last: 130 });
  });

  it("follows audio that plays on after the turn is done", () => {
    const bounds = speechBounds(levels(range(100, 150)), {
      start: 100,
      end: 110,
      floor: 0,
      ceiling: 200,
    });
    expect(bounds.last).toBe(150);
  });

  it("falls back to the events when there are no levels", () => {
    const bounds = speechBounds(levels([]), { start: 100, end: 110, floor: 0, ceiling: 200 });
    expect(bounds).toEqual({ first: 100, last: 110 });
  });
});

describe("voiceCallCaption", () => {
  const turn = (turnId: string, endedAt: number | null, text = "words") => ({
    turnId,
    speaker: "user" as const,
    text,
    startedAt: 0,
    endedAt,
  });

  it("shows the latest turns and highlights the last one when nobody speaks", () => {
    const { turns, currentTurnId } = voiceCallCaption(
      ["a", "b", "c", "d"].map((id) => turn(id, 1)),
    );
    expect(turns.map((entry) => entry.turnId)).toEqual(["b", "c", "d"]);
    expect(currentTurnId).toBe("d");
  });

  it("highlights the open turn even when a later one has ended", () => {
    const { currentTurnId } = voiceCallCaption([turn("a", null), turn("b", 1)]);
    expect(currentTurnId).toBe("a");
  });

  it("keeps an open turn without words but drops an ended one", () => {
    const { turns } = voiceCallCaption([turn("a", 1, ""), turn("b", null, "")]);
    expect(turns.map((entry) => entry.turnId)).toEqual(["b"]);
  });

  it("has nothing to highlight without turns", () => {
    expect(voiceCallCaption([])).toEqual({ turns: [], currentTurnId: null });
  });
});
