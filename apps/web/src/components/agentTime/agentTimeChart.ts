/**
 * Fork: the numbers behind the "Agent time" chart: per-period stacks, window
 * totals, a duration axis, and duration labels.
 *
 * @module agentTimeChart
 */
import {
  AGENT_TIME_CATEGORIES,
  AGENT_TIME_PASSIVE_CATEGORIES,
  type AgentTimeCategory,
  type AgentTimeSummary,
} from "@t3tools/contracts";

export const CATEGORY_PRESENTATION: Record<
  AgentTimeCategory,
  { readonly label: string; readonly color: string }
> = {
  modelThinking: { label: "Model: thinking", color: "#8b5cf6" },
  modelOutput: { label: "Model: output", color: "#c4b5fd" },
  tests: { label: "Tests", color: "#22c55e" },
  build: { label: "Build, typecheck & lint", color: "#f59e0b" },
  gitCi: { label: "Git & CI", color: "#f97316" },
  database: { label: "Database", color: "#06b6d4" },
  browser: { label: "Browser & screenshots", color: "#ec4899" },
  jobs: { label: "Jobs & scripts", color: "#3b82f6" },
  files: { label: "Read, search & edit files", color: "#14b8a6" },
  otherTools: { label: "Other tools", color: "#64748b" },
  waiting: { label: "Waiting & polling", color: "#a8a29e" },
  compactionErrors: { label: "Compaction & errors", color: "#ef4444" },
  children: { label: "Waiting on subagents", color: "#818cf8" },
  idle: { label: "Idle", color: "#d4d4d8" },
};

export interface AgentTimeColumn {
  readonly period: string;
  /** Seconds per category, in `AGENT_TIME_CATEGORIES` order. */
  readonly seconds: readonly number[];
}

export interface AgentTimeChartData {
  readonly columns: readonly AgentTimeColumn[];
  /** Window totals in seconds, in `AGENT_TIME_CATEGORIES` order. */
  readonly totals: readonly number[];
  /** Seconds of everything but waiting on subagents and idle. */
  readonly activeTotal: number;
}

/** Adds up every environment's buckets onto the window's periods. */
export function buildAgentTimeChart(
  periods: readonly string[],
  summaries: readonly AgentTimeSummary[],
): AgentTimeChartData {
  const indexByPeriod = new Map(periods.map((period, index) => [period, index]));
  const categoryIndex = new Map(AGENT_TIME_CATEGORIES.map((category, index) => [category, index]));
  const grid = periods.map(() => AGENT_TIME_CATEGORIES.map(() => 0));
  for (const summary of summaries) {
    for (const bucket of summary.buckets) {
      const row = grid[indexByPeriod.get(bucket.start) ?? -1];
      if (row === undefined) continue;
      for (const entry of bucket.categories) {
        const index = categoryIndex.get(entry.category);
        if (index !== undefined) row[index]! += entry.seconds;
      }
    }
  }
  const totals = AGENT_TIME_CATEGORIES.map((_, index) =>
    grid.reduce((sum, row) => sum + row[index]!, 0),
  );
  const activeTotal = AGENT_TIME_CATEGORIES.reduce(
    (sum, category, index) =>
      AGENT_TIME_PASSIVE_CATEGORIES.has(category) ? sum : sum + totals[index]!,
    0,
  );
  return {
    columns: periods.map((period, index) => ({ period, seconds: grid[index]! })),
    totals,
    activeTotal,
  };
}

/**
 * The shown categories of one column that have time, longest first. The bars
 * keep a fixed stacking order; the tooltip lists by duration.
 */
export function categoriesByDuration(
  seconds: readonly number[],
  shown: readonly number[],
): readonly number[] {
  return shown
    .filter((categoryIndex) => (seconds[categoryIndex] ?? 0) > 0)
    .toSorted((left, right) => seconds[right]! - seconds[left]!);
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const AXIS_STEPS = [
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  4 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
  48 * HOUR,
];

/** An axis of round durations whose top is at or above `peakSeconds`. */
export function durationScale(
  peakSeconds: number,
  tickCount: number,
): { readonly max: number; readonly ticks: readonly number[] } {
  if (peakSeconds <= 0) return { max: 0, ticks: [0] };
  const step =
    AXIS_STEPS.find((candidate) => candidate * tickCount >= peakSeconds) ??
    Math.ceil(peakSeconds / tickCount / (24 * HOUR)) * 24 * HOUR;
  const max = Math.ceil(peakSeconds / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

/** `2h 05m`, `45m`, `30s`. */
export function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < MINUTE) return `${rounded}s`;
  const minutes = Math.round(rounded / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
}
