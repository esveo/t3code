import { AGENT_TIME_CATEGORIES, type AgentTimeSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentTimeChart,
  categoriesByDuration,
  durationScale,
  formatDuration,
} from "./agentTimeChart";

const summary = (buckets: AgentTimeSummary["buckets"]): AgentTimeSummary => ({
  readAt: "2026-10-16T00:00:00.000Z",
  timeZone: "UTC",
  resolution: "day",
  buckets,
  projects: [],
  scanDurationMs: 0,
});

describe("buildAgentTimeChart", () => {
  it("adds environments together and leaves passive categories out of the active total", () => {
    const chart = buildAgentTimeChart(
      ["2026-10-15", "2026-10-16"],
      [
        summary([
          {
            start: "2026-10-15",
            categories: [
              { category: "tests", seconds: 600 },
              { category: "idle", seconds: 300 },
            ],
          },
        ]),
        summary([
          { start: "2026-10-15", categories: [{ category: "tests", seconds: 60 }] },
          // Outside the window: ignored.
          { start: "2026-10-01", categories: [{ category: "build", seconds: 999 }] },
        ]),
      ],
    );
    const tests = AGENT_TIME_CATEGORIES.indexOf("tests");
    const idle = AGENT_TIME_CATEGORIES.indexOf("idle");
    expect(chart.columns[0]!.seconds[tests]).toBe(660);
    expect(chart.columns[1]!.seconds.every((seconds) => seconds === 0)).toBe(true);
    expect(chart.totals[idle]).toBe(300);
    expect(chart.activeTotal).toBe(660);
  });
});

describe("categoriesByDuration", () => {
  it("lists the shown categories with time, longest first", () => {
    // Category 3 is hidden, category 2 has no time.
    expect(categoriesByDuration([60, 300, 0, 900, 120], [0, 1, 2, 4])).toEqual([1, 4, 0]);
  });
});

describe("durationScale", () => {
  it("picks round duration steps that reach the peak", () => {
    expect(durationScale(0, 4)).toEqual({ max: 0, ticks: [0] });
    expect(durationScale(50 * 60, 4)).toEqual({ max: 3600, ticks: [0, 900, 1800, 2700, 3600] });
    expect(durationScale(7 * 3600, 4).max).toBe(8 * 3600);
  });
});

describe("formatDuration", () => {
  it("reads as seconds, minutes, or hours and minutes", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe("2h 05m");
    expect(formatDuration(3 * 3600)).toBe("3h");
  });
});
