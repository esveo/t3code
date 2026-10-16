/**
 * Fork: the Usage page's "Agent time", read from the thread projections.
 *
 * Reads the Claude runs that overlap the window (plus a margin, so waits that
 * started before it or end after it are seen whole) and their turn items,
 * attributes each thread's time (`agentTimeAttribution.ts`), and returns
 * per-bucket totals. Past days do not change, so their totals are kept in
 * memory per time zone and a repeat read only computes the recent days.
 *
 * @module AgentTime
 */
import {
  AGENT_TIME_CATEGORIES,
  AGENT_TIME_PASSIVE_CATEGORIES,
  AgentTimeReadError,
  ProjectId,
  type AgentTimeBucket,
  type AgentTimeSummary,
  type AgentTimeSummaryInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import {
  BACKGROUND_WAIT_CAP_MS,
  CATEGORY_COUNT,
  attributeThread,
  type AgentTimeItem,
  type AgentTimeRun,
} from "./agentTimeAttribution.ts";
import { dayEdges, enumerateWindowDays, hourEdges, isoInstant } from "./agentTimeBuckets.ts";
import { openAgentTimeReader } from "./agentTimeReader.ts";

/** Only Claude threads are attributed for now. */
const PROVIDER = "claudeAgent";
const MAX_DAYS = 120;
/** A day is final, and cached, once it ended this long ago. */
const FINAL_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_DAYS = 2_000;
/** Attribution hands the thread back after about this many items (~20 ms). */
const ITEMS_PER_SLICE = 3_000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "mcp_tool_call",
  "file_change",
  "web_search",
  "reasoning",
  "compaction",
  "error",
  "subagent",
  "user_input_request",
  "notification",
] as const;

export class AgentTime extends Context.Service<
  AgentTime,
  {
    readonly summary: (
      input: AgentTimeSummaryInput,
    ) => Effect.Effect<AgentTimeSummary, AgentTimeReadError>;
  }
>()("t3/agentTime/AgentTime") {}

/** Seconds per category, row-major by bucket, for each project. */
type ProjectTotals = Map<string, Float64Array>;

interface RunRow {
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

interface ItemRow {
  readonly threadId: string;
  readonly runId: string | null;
  readonly type: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly toolName: string | null;
  readonly command: string | null;
  readonly outputHead: string | null;
  readonly taskId: string | null;
  readonly notificationKind: string | null;
  readonly notificationOutcome: string | null;
  readonly notificationSummary: string | null;
}

const invalidWindow = () => new AgentTimeReadError({ reason: "invalidWindow" });
const readFailed = (cause: unknown) => new AgentTimeReadError({ reason: "readFailed", cause });

function isValidTimeZone(timeZone: string): boolean {
  try {
    return Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

// Parameters: provider, query end, query start.
const RUNS_SQL = `
  SELECT run.run_id AS "runId", run.thread_id AS "threadId", thread.project_id AS "projectId",
    run.status AS "status", run.requested_at AS "requestedAt", run.completed_at AS "completedAt"
  FROM orchestration_v2_projection_runs AS run
  JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = run.thread_id
  WHERE run.provider = ?
    AND run.requested_at < ?
    AND (run.completed_at IS NULL OR run.completed_at >= ?)
`;

// Parameters: provider, query end, query start.
const ITEMS_SQL = `
  SELECT item.thread_id AS "threadId", item.run_id AS "runId", item.type AS "type",
    json_extract(item.payload_json, '$.startedAt') AS "startedAt",
    json_extract(item.payload_json, '$.completedAt') AS "completedAt",
    CASE WHEN item.type = 'dynamic_tool' THEN json_extract(item.payload_json, '$.toolName') END AS "toolName",
    CASE WHEN item.type = 'command_execution' THEN substr(json_extract(item.payload_json, '$.input'), 1, 2000) END AS "command",
    CASE WHEN item.type = 'command_execution' THEN substr(json_extract(item.payload_json, '$.output'), 1, 80) END AS "outputHead",
    CASE WHEN item.type = 'dynamic_tool' THEN json_extract(item.payload_json, '$.input.task_id') END AS "taskId",
    CASE WHEN item.type = 'notification' THEN json_extract(item.payload_json, '$.source.kind') END AS "notificationKind",
    CASE WHEN item.type = 'notification' THEN json_extract(item.payload_json, '$.outcome') END AS "notificationOutcome",
    CASE WHEN item.type = 'notification' THEN json_extract(item.payload_json, '$.summary') END AS "notificationSummary"
  FROM orchestration_v2_projection_turn_items AS item
  WHERE item.run_id IN (
      SELECT run.run_id FROM orchestration_v2_projection_runs AS run
      WHERE run.provider = ?
        AND run.requested_at < ?
        AND (run.completed_at IS NULL OR run.completed_at >= ?)
    )
    AND item.type IN (${ITEM_TYPES.map((type) => `'${type}'`).join(", ")})
`;

const PROJECTS_SQL = `SELECT project_id AS "projectId", title AS "title" FROM projection_projects`;

const make = Effect.fn("AgentTime.make")(function* (dbPath: string) {
  // node:sqlite blocks its thread, so the long reads run on a worker.
  const reader = yield* Effect.acquireRelease(
    Effect.sync(() => openAgentTimeReader(dbPath)),
    (opened) => Effect.promise(() => opened.close()),
  );
  const read = <Row>(sql: string, params: ReadonlyArray<string | number> = []) =>
    Effect.tryPromise({ try: () => reader.all<Row>(sql, params), catch: readFailed });
  // `${timeZone}|${day}` -> seconds per category for each project.
  const dayCache = new Map<string, ProjectTotals>();

  const computeTotals = Effect.fn("AgentTime.computeTotals")(function* (
    edges: ReadonlyArray<number>,
    nowMs: number,
  ) {
    const bucketCount = edges.length - 1;
    const queryStart = isoInstant(edges[0]! - BACKGROUND_WAIT_CAP_MS);
    const queryEnd = isoInstant(edges[bucketCount]! + BACKGROUND_WAIT_CAP_MS);
    const window = [PROVIDER, queryEnd, queryStart];
    const runRows = yield* read<RunRow>(RUNS_SQL, window);
    const totals: ProjectTotals = new Map();
    if (runRows.length === 0) return totals;

    const itemRows = yield* read<ItemRow>(ITEMS_SQL, window);

    const lastItemEndByRun = new Map<string, number>();
    for (const row of itemRows) {
      if (row.runId === null) continue;
      const end = Date.parse(row.completedAt ?? row.startedAt ?? "");
      if (Number.isFinite(end) && end > (lastItemEndByRun.get(row.runId) ?? 0)) {
        lastItemEndByRun.set(row.runId, end);
      }
    }

    const threads = new Map<
      string,
      { projectId: string; runs: AgentTimeRun[]; items: AgentTimeItem[] }
    >();
    const runEnds = new Map<string, number>();
    for (const run of runRows) {
      const startMs = Date.parse(run.requestedAt);
      if (!Number.isFinite(startMs)) continue;
      const completedMs = run.completedAt === null ? Number.NaN : Date.parse(run.completedAt);
      // A run that never recorded its end stopped at its last item, unless it still runs.
      const endMs = Number.isFinite(completedMs)
        ? completedMs
        : ACTIVE_RUN_STATUSES.has(run.status)
          ? nowMs
          : Math.max(startMs, lastItemEndByRun.get(run.runId) ?? startMs);
      runEnds.set(run.runId, endMs);
      let thread = threads.get(run.threadId);
      if (thread === undefined) {
        thread = { projectId: run.projectId, runs: [], items: [] };
        threads.set(run.threadId, thread);
      }
      thread.runs.push({ startMs, endMs });
    }

    for (const row of itemRows) {
      const thread = threads.get(row.threadId);
      if (thread === undefined) continue;
      const startMs = Date.parse(row.startedAt ?? "");
      if (!Number.isFinite(startMs)) continue;
      const completedMs = row.completedAt === null ? Number.NaN : Date.parse(row.completedAt);
      const runEnd = row.runId === null ? undefined : runEnds.get(row.runId);
      const endMs = Number.isFinite(completedMs)
        ? completedMs
        : Math.max(startMs, Math.min(runEnd ?? startMs, nowMs));
      thread.items.push({
        type: row.type,
        startMs,
        endMs,
        toolName: row.toolName,
        command: row.command,
        outputHead: row.outputHead,
        taskId: row.taskId,
        notificationKind: row.notificationKind,
        notificationOutcome: row.notificationOutcome,
        notificationSummary: row.notificationSummary,
      });
    }

    let itemsSinceYield = 0;
    for (const thread of threads.values()) {
      thread.items.sort((left, right) => left.startMs - right.startMs);
      let projectTotals = totals.get(thread.projectId);
      if (projectTotals === undefined) {
        projectTotals = new Float64Array(bucketCount * CATEGORY_COUNT);
        totals.set(thread.projectId, projectTotals);
      }
      attributeThread(thread, edges, projectTotals);
      // The server's thread is shared with every request and running agent.
      itemsSinceYield += thread.items.length;
      if (itemsSinceYield >= ITEMS_PER_SLICE) {
        itemsSinceYield = 0;
        yield* Effect.yieldNow;
      }
    }
    return totals;
  });

  /** Daily totals, reusing the cached final days. Returns one entry per day. */
  const dailyTotals = Effect.fn("AgentTime.dailyTotals")(function* (
    days: ReadonlyArray<string>,
    timeZone: string,
    nowMs: number,
  ) {
    const perDay: ProjectTotals[] = days.map(
      (day) => dayCache.get(`${timeZone}|${day}`) ?? new Map(),
    );
    // Each stretch of uncached days is read on its own, so widening the window
    // does not re-read the cached days in between.
    const gaps: Array<{ first: number; last: number }> = [];
    days.forEach((day, index) => {
      if (dayCache.has(`${timeZone}|${day}`)) return;
      const gap = gaps.at(-1);
      if (gap !== undefined && gap.last === index - 1) gap.last = index;
      else gaps.push({ first: index, last: index });
    });
    for (const { first, last } of gaps) {
      const rangeDays = days.slice(first, last + 1);
      const edges = dayEdges(rangeDays, timeZone);
      const totals = yield* computeTotals(edges, nowMs);
      rangeDays.forEach((day, offset) => {
        const dayTotals: ProjectTotals = new Map();
        for (const [projectId, values] of totals) {
          dayTotals.set(
            projectId,
            values.slice(offset * CATEGORY_COUNT, (offset + 1) * CATEGORY_COUNT),
          );
        }
        perDay[first + offset] = dayTotals;
        if (edges[offset + 1]! + FINAL_AFTER_MS < nowMs) {
          if (dayCache.size >= MAX_CACHED_DAYS) dayCache.clear();
          dayCache.set(`${timeZone}|${day}`, dayTotals);
        }
      });
    }
    return perDay;
  });

  const projectTitles = read<{ readonly projectId: string; readonly title: string }>(PROJECTS_SQL);

  const summary: AgentTime["Service"]["summary"] = Effect.fn("AgentTime.summary")(
    function* (input) {
      const startedMs = yield* Clock.currentTimeMillis;
      if (!isValidTimeZone(input.timeZone)) return yield* invalidWindow();
      const resolution = input.resolution ?? "day";

      let bucketStarts: string[];
      let perBucket: ProjectTotals[];
      if (resolution === "hour") {
        const sinceMs = Date.parse(input.sinceTime ?? "");
        const untilMs = Date.parse(input.untilTime ?? "");
        if (
          !Number.isFinite(sinceMs) ||
          !Number.isFinite(untilMs) ||
          untilMs <= sinceMs ||
          untilMs - sinceMs > 7 * 24 * 60 * 60 * 1000
        ) {
          return yield* invalidWindow();
        }
        const edges = hourEdges(sinceMs, untilMs);
        const totals = yield* computeTotals(edges, startedMs);
        bucketStarts = edges.slice(0, -1).map(isoInstant);
        perBucket = bucketStarts.map((_, index) => {
          const bucketTotals: ProjectTotals = new Map();
          for (const [projectId, values] of totals) {
            bucketTotals.set(
              projectId,
              values.slice(index * CATEGORY_COUNT, (index + 1) * CATEGORY_COUNT),
            );
          }
          return bucketTotals;
        });
      } else {
        const days = enumerateWindowDays(input.sinceDay, input.untilDay);
        if (days.length === 0 || days.length > MAX_DAYS) return yield* invalidWindow();
        bucketStarts = days;
        perBucket = yield* dailyTotals(days, input.timeZone, startedMs);
      }

      const projectActive = new Map<string, number>();
      const buckets: AgentTimeBucket[] = bucketStarts.map((start, index) => {
        const sums = new Float64Array(CATEGORY_COUNT);
        for (const [projectId, values] of perBucket[index]!) {
          let active = 0;
          for (let category = 0; category < CATEGORY_COUNT; category += 1) {
            if (!AGENT_TIME_PASSIVE_CATEGORIES.has(AGENT_TIME_CATEGORIES[category]!)) {
              active += values[category]!;
            }
          }
          projectActive.set(projectId, (projectActive.get(projectId) ?? 0) + active);
          if (input.projectId !== undefined && projectId !== input.projectId) continue;
          for (let category = 0; category < CATEGORY_COUNT; category += 1) {
            sums[category]! += values[category]!;
          }
        }
        return {
          start,
          categories: AGENT_TIME_CATEGORIES.flatMap((category, categoryIndex) =>
            sums[categoryIndex]! > 0
              ? [{ category, seconds: Math.round(sums[categoryIndex]!) }]
              : [],
          ),
        };
      });

      const titles = new Map(
        (yield* projectTitles).map((row) => [row.projectId, row.title] as const),
      );
      const projects = [...projectActive]
        .filter(([, active]) => active > 0)
        .toSorted((left, right) => right[1] - left[1])
        .map(([projectId, activeSeconds]) => ({
          projectId: ProjectId.make(projectId),
          title: titles.get(projectId) ?? projectId,
          activeSeconds: Math.round(activeSeconds),
        }));

      const finishedMs = yield* Clock.currentTimeMillis;
      return {
        readAt: isoInstant(finishedMs),
        timeZone: input.timeZone,
        resolution,
        buckets,
        projects,
        scanDurationMs: finishedMs - startedMs,
      };
    },
  );

  return AgentTime.of({ summary });
});

/** Agent time read from the database file at `dbPath`. */
export const layerFromDbPath = (dbPath: string) => Layer.effect(AgentTime, make(dbPath));

export const layer = Layer.effect(
  AgentTime,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make(config.dbPath);
  }),
);

/**
 * The RPC side reads the service optionally, so it does not join the
 * requirements of every server test that builds the RPC layer.
 */
export const summaryRpc = (input: AgentTimeSummaryInput) =>
  Effect.flatMap(Effect.serviceOption(AgentTime), (agentTime) =>
    Option.isSome(agentTime)
      ? agentTime.value.summary(input)
      : Effect.fail(new AgentTimeReadError({ reason: "unavailable" })),
  );
