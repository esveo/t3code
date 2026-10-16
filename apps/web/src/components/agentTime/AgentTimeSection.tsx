/**
 * Fork: the Usage page's "Agent time" section. A stacked bar per period of
 * what Claude agents spent their time on, and the window's totals per
 * category. Follows the page's window and environment selection.
 */
import {
  AGENT_TIME_CATEGORIES,
  AGENT_TIME_PASSIVE_CATEGORIES,
  type AgentTimeSummary,
  type AgentTimeSummaryInput,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDayShort,
  formatHourShort,
  formatPercent,
} from "@t3tools/shared/usageFormat";
import { useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  CATEGORY_PRESENTATION,
  buildAgentTimeChart,
  durationScale,
  formatDuration,
  type AgentTimeChartData,
} from "./agentTimeChart";
import { useAgentTime } from "./agentTimeState";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PLOT_TOP = 8;
const TICK_COUNT = 4;
const ALL_PROJECTS = "all";

interface ProjectOption {
  readonly value: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

interface Shown {
  readonly periods: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly summaries: readonly AgentTimeSummary[];
}

export function AgentTimeSection({
  environments,
  window,
}: {
  /** The page's selected environments. */
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly window: AgentTimeSummaryInput;
}) {
  const [selectedProject, setSelectedProject] = useState<ProjectOption | null>(null);
  const [showPassive, setShowPassive] = useState(false);

  const readableIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.canReadDiagnostics)
        .map((environment) => environment.environmentId),
    [environments],
  );
  const environmentIds = useMemo(
    () => (selectedProject === null ? readableIds : [selectedProject.environmentId]),
    [readableIds, selectedProject],
  );
  const input = useMemo<AgentTimeSummaryInput>(
    () => ({
      sinceDay: window.sinceDay,
      untilDay: window.untilDay,
      timeZone: window.timeZone,
      ...(window.resolution === undefined ? {} : { resolution: window.resolution }),
      ...(window.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
      ...(window.untilTime === undefined ? {} : { untilTime: window.untilTime }),
      ...(selectedProject === null ? {} : { projectId: selectedProject.projectId }),
    }),
    [window, selectedProject],
  );
  const answers = useAgentTime(environmentIds, input);
  const pending = answers.some((answer) => answer.isPending);
  const failed = answers.length > 0 && answers.every((answer) => answer.failed);

  // Until the new window or project answers, the last answer stays on screen, muted.
  const [shown, setShown] = useState<Shown | null>(null);
  const summaries = answers.flatMap((answer) => (answer.summary === null ? [] : [answer.summary]));
  if (
    summaries.length > 0 &&
    !pending &&
    (shown === null ||
      shown.summaries.length !== summaries.length ||
      shown.summaries.some((summary, index) => summary !== summaries[index]))
  ) {
    const resolution = input.resolution === "hour" ? "hour" : "day";
    setShown({
      periods:
        resolution === "hour" && input.sinceTime !== undefined && input.untilTime !== undefined
          ? enumerateHourStarts(input.sinceTime, input.untilTime)
          : enumerateDays(input.sinceDay, input.untilDay),
      resolution,
      timeZone: input.timeZone,
      summaries,
    });
  }
  const chart = useMemo(
    () => (shown === null ? null : buildAgentTimeChart(shown.periods, shown.summaries)),
    [shown],
  );

  const projectOptions = useMemo(() => {
    const options = new Map<string, ProjectOption>();
    const labelOf = new Map(
      environments.map((environment) => [environment.environmentId, environment.label]),
    );
    for (const answer of answers) {
      for (const project of answer.summary?.projects ?? []) {
        const value = `${answer.environmentId}\u0000${project.projectId}`;
        options.set(value, {
          value,
          environmentId: answer.environmentId,
          projectId: project.projectId,
          label:
            readableIds.length > 1
              ? `${project.title} · ${labelOf.get(answer.environmentId) ?? ""}`
              : project.title,
        });
      }
    }
    if (selectedProject !== null) options.set(selectedProject.value, selectedProject);
    return options;
  }, [answers, environments, readableIds.length, selectedProject]);

  if (readableIds.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          Agent time
          {pending ? (
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <Spinner size="xs" tone="muted" />
              Computing…
            </span>
          ) : null}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch size="sm" checked={showPassive} onCheckedChange={setShowPassive} />
            Waiting on subagents &amp; idle
          </label>
          <Select
            value={selectedProject?.value ?? ALL_PROJECTS}
            onValueChange={(value) => setSelectedProject(projectOptions.get(value ?? "") ?? null)}
          >
            <SelectTrigger
              aria-label="Agent time project"
              size="compact"
              variant="ghost"
              className="w-auto max-w-56 min-w-0"
            >
              <SelectValue>{selectedProject?.label ?? "All projects"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {[...projectOptions.values()].map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {failed && shown === null ? (
        <p className="py-6 text-sm text-muted-foreground">Agent time could not be read.</p>
      ) : shown === null || chart === null ? (
        <div className="h-56" />
      ) : (
        <div
          className={cn(
            "flex flex-col gap-4 transition-opacity",
            pending && "opacity-40 delay-150",
          )}
        >
          <AgentTimeChart chart={chart} shown={shown} showPassive={showPassive} />
          <AgentTimeTotals chart={chart} showPassive={showPassive} />
          <p className="text-xs text-muted-foreground">
            Claude threads only. Each thread&apos;s wall-clock time is split into what it was doing,
            so threads running in parallel add up.
          </p>
        </div>
      )}
    </section>
  );
}

function visibleIndexes(showPassive: boolean): readonly number[] {
  return AGENT_TIME_CATEGORIES.flatMap((category, index) =>
    showPassive || !AGENT_TIME_PASSIVE_CATEGORIES.has(category) ? [index] : [],
  );
}

function AgentTimeChart({
  chart,
  shown,
  showPassive,
}: {
  readonly chart: AgentTimeChartData;
  readonly shown: Shown;
  readonly showPassive: boolean;
}) {
  const [hover, setHover] = useState<{
    readonly index: number;
    readonly category: number | null;
    readonly x: number;
    readonly y: number;
    readonly width: number;
  } | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const visible = visibleIndexes(showPassive);
  const columnTotals = chart.columns.map((column) =>
    visible.reduce((sum, index) => sum + column.seconds[index]!, 0),
  );
  const scale = durationScale(Math.max(0, ...columnTotals), TICK_COUNT);
  const toY = (seconds: number) =>
    scale.max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (seconds / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
  const count = chart.columns.length;
  const band = count === 0 ? VIEW_WIDTH : VIEW_WIDTH / count;
  const barWidth = Math.max(1, band * 0.72);
  const periods = shown.periods;
  const formatPeriod = (period: string) =>
    shown.resolution === "hour" ? formatHourShort(period, shown.timeZone) : formatDayShort(period);

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || count === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const y = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    const index = Math.min(count - 1, Math.floor((x / bounds.width) * count));
    // Which stacked segment the pointer is over, from the bottom up.
    const value =
      scale.max === 0
        ? 0
        : ((((bounds.height - y) / bounds.height) * VIEW_HEIGHT) / (VIEW_HEIGHT - PLOT_TOP)) *
          scale.max;
    let category: number | null = null;
    let base = 0;
    for (const categoryIndex of visible) {
      const seconds = chart.columns[index]!.seconds[categoryIndex]!;
      if (seconds > 0 && value >= base && value < base + seconds) category = categoryIndex;
      base += seconds;
    }
    setHover({ index, category, x, y, width: bounds.width });
  };

  const hoveredColumn = hover === null ? undefined : chart.columns[hover.index];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatDuration(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="relative h-56 min-w-0 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${shown.resolution === "hour" ? "Hourly" : "Daily"} agent time by kind of work`}
          >
            {scale.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {chart.columns.map((column, columnIndex) => {
              const x = columnIndex * band + (band - barWidth) / 2;
              let base = 0;
              return (
                <g
                  key={column.period}
                  opacity={hover !== null && hover.index !== columnIndex ? 0.55 : 1}
                >
                  {visible.map((categoryIndex) => {
                    const seconds = column.seconds[categoryIndex]!;
                    if (seconds <= 0) return null;
                    const top = toY(base + seconds);
                    const bottom = toY(base);
                    base += seconds;
                    const category = AGENT_TIME_CATEGORIES[categoryIndex]!;
                    return (
                      <rect
                        key={category}
                        x={x}
                        y={top}
                        width={barWidth}
                        height={Math.max(0, bottom - top)}
                        fill={CATEGORY_PRESENTATION[category].color}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>

          {hover === null || hoveredColumn === undefined ? null : (
            <div
              className="surface-glass pointer-events-none absolute z-10 min-w-44 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left:
                  hover.x + 12 + 208 <= hover.width
                    ? hover.x + 12
                    : Math.max(0, hover.x - 12 - 208),
                top: Math.max(0, hover.y - 16),
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatPeriod(hoveredColumn.period)}</div>
              {visible
                .filter((categoryIndex) => hoveredColumn.seconds[categoryIndex]! > 0)
                .toReversed()
                .map((categoryIndex) => {
                  const category = AGENT_TIME_CATEGORIES[categoryIndex]!;
                  return (
                    <div
                      key={category}
                      className={cn(
                        "flex items-center justify-between gap-3",
                        hover.category === categoryIndex
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="size-2 shrink-0 rounded-sm"
                          style={{ backgroundColor: CATEGORY_PRESENTATION[category].color }}
                        />
                        {CATEGORY_PRESENTATION[category].label}
                      </span>
                      <span className="tabular-nums">
                        {formatDuration(hoveredColumn.seconds[categoryIndex]!)}
                      </span>
                    </div>
                  );
                })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">
                  {formatDuration(columnTotals[hover.index] ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)]!)}
        </span>
        <span>{periods.at(-1) === undefined ? "" : formatPeriod(periods.at(-1)!)}</span>
      </div>
    </div>
  );
}

function AgentTimeTotals({
  chart,
  showPassive,
}: {
  readonly chart: AgentTimeChartData;
  readonly showPassive: boolean;
}) {
  const rows = AGENT_TIME_CATEGORIES.map((category, index) => ({
    category,
    seconds: chart.totals[index]!,
    passive: AGENT_TIME_PASSIVE_CATEGORIES.has(category),
  }))
    .filter((row) => row.seconds > 0)
    .toSorted(
      (left, right) => Number(left.passive) - Number(right.passive) || right.seconds - left.seconds,
    );

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent time in this period.</p>;
  }
  return (
    <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
      {rows.map((row) => (
        <div
          key={row.category}
          className={cn(
            "flex items-center justify-between gap-3 text-xs",
            row.passive && !showPassive && "opacity-60",
          )}
        >
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: CATEGORY_PRESENTATION[row.category].color }}
            />
            <span className="truncate">{CATEGORY_PRESENTATION[row.category].label}</span>
          </span>
          <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
            <span className="text-foreground">{formatDuration(row.seconds)}</span>
            <span className="w-12 text-right text-muted-foreground">
              {row.passive || chart.activeTotal === 0
                ? ""
                : formatPercent(row.seconds / chart.activeTotal)}
            </span>
          </span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-1.5 text-xs sm:col-span-2">
        <span className="text-muted-foreground">Active total</span>
        <span className="text-foreground tabular-nums">{formatDuration(chart.activeTotal)}</span>
      </div>
    </div>
  );
}
