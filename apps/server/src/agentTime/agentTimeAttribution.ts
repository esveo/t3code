/**
 * Fork: splits a thread's wall-clock time into agent-time categories.
 *
 * Every instant of a thread's history goes to exactly one claim level, the
 * highest one with anything active, so a thread's categories add up to its
 * wall-clock time:
 *
 * 0. Own work: tool calls, thinking, compaction and errors. Parallel calls
 *    share the overlap equally.
 * 1. Waiting: background commands until their completion notification, and
 *    subagents and delegated tasks until they finish.
 * 2. Model output: the rest of a run, the time between events the model
 *    spends writing (latency included).
 * 3. Idle: the gap between two runs, when it is short enough to be a pause.
 *
 * Intervals are split at bucket edges. Pure, so the service can cache and the
 * tests can feed it timelines directly.
 *
 * @module agentTimeAttribution
 */
import { AGENT_TIME_CATEGORIES, type AgentTimeCategory } from "@t3tools/contracts";

import { classifyCommand, classifyItem } from "./agentTimeClassifier.ts";

export const CATEGORY_COUNT = AGENT_TIME_CATEGORIES.length;
const CATEGORY_INDEX = new Map<AgentTimeCategory, number>(
  AGENT_TIME_CATEGORIES.map((category, index) => [category, index]),
);

/** Pauses between runs longer than this are the user away, not idle agent time. */
export const IDLE_GAP_CAP_MS = 60 * 60 * 1000;
/** A background command still running after this is a server or watch, not a wait. */
export const BACKGROUND_WAIT_CAP_MS = 6 * 60 * 60 * 1000;

export interface AgentTimeRun {
  readonly startMs: number;
  readonly endMs: number;
}

export interface AgentTimeItem {
  readonly type: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly toolName?: string | null;
  /** The command line of a `command_execution`. */
  readonly command?: string | null;
  /** The start of a `command_execution`'s output; marks a background command. */
  readonly outputHead?: string | null;
  /** `task_id` argument of TaskOutput/BashOutput, naming a background command. */
  readonly taskId?: string | null;
  readonly notificationKind?: string | null;
  readonly notificationOutcome?: string | null;
  readonly notificationSummary?: string | null;
}

export interface AgentTimeThread {
  readonly runs: ReadonlyArray<AgentTimeRun>;
  /** Sorted by start. */
  readonly items: ReadonlyArray<AgentTimeItem>;
}

/** `Command "…" finished`: a report on exactly one command. */
const SINGLE_COMMAND_REPORT = /^Command "(?:(?!", command ").)*" \S+/;
const BACKGROUND_OUTPUT = /^Command running in background with ID: (\S+?)\.?(?:\s|$)/;

/**
 * The label a completion notification quotes a command by. Mirrors
 * `reportLabel` in provider-core's notification module.
 */
export function backgroundCommandLabel(command: string): string | null {
  const firstLine = command.trim().split("\n")[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return null;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

interface Claim {
  readonly startMs: number;
  readonly endMs: number;
  readonly level: number;
  readonly category: number;
}

const LEVELS = 4;

function categoryIndex(category: AgentTimeCategory): number {
  return CATEGORY_INDEX.get(category) ?? CATEGORY_INDEX.get("otherTools")!;
}

/** Statistics on how background commands were matched, for diagnostics. */
export interface BackgroundMatchStats {
  started: number;
  matched: number;
}

function collectClaims(thread: AgentTimeThread, stats?: BackgroundMatchStats): Claim[] {
  const claims: Claim[] = [];
  const notifications = thread.items.filter(
    (item) =>
      item.type === "notification" &&
      (item.notificationKind === "background_command" ||
        item.notificationKind === "background_task"),
  );
  const usedNotifications = new Set<AgentTimeItem>();
  const backgroundCategories = new Map<string, AgentTimeCategory>();
  const unmatched: Array<{ item: AgentTimeItem; category: AgentTimeCategory }> = [];
  const claimWait = (
    start: AgentTimeItem,
    category: AgentTimeCategory,
    completion: AgentTimeItem,
  ) => {
    // A stopped command was not awaited; one running for hours is a server.
    if (
      completion.notificationOutcome !== "cancelled" &&
      completion.startMs - start.startMs <= BACKGROUND_WAIT_CAP_MS
    ) {
      claims.push({
        startMs: start.startMs,
        endMs: completion.startMs,
        level: 1,
        category: categoryIndex(category),
      });
    }
  };

  for (const item of thread.items) {
    if (item.type === "command_execution") {
      const command = item.command ?? "";
      const category = classifyCommand(command);
      const background = item.outputHead ? BACKGROUND_OUTPUT.exec(item.outputHead) : null;
      if (background !== null) {
        backgroundCategories.set(background[1]!, category);
        if (stats) stats.started += 1;
        const label = backgroundCommandLabel(command);
        const quoted = label === null ? null : `"${label}`;
        const completion =
          quoted === null
            ? undefined
            : notifications.find(
                (notification) =>
                  !usedNotifications.has(notification) &&
                  notification.notificationOutcome !== "updated" &&
                  notification.startMs >= item.startMs &&
                  notification.notificationSummary?.includes(quoted) === true,
              );
        if (completion === undefined) {
          unmatched.push({ item, category });
        } else {
          usedNotifications.add(completion);
          if (stats) stats.matched += 1;
          claimWait(item, category, completion);
        }
      }
      claims.push({
        startMs: item.startMs,
        endMs: item.endMs,
        level: 0,
        category: categoryIndex(category),
      });
      continue;
    }
    if (
      item.type === "dynamic_tool" &&
      (item.toolName === "TaskOutput" || item.toolName === "BashOutput") &&
      item.taskId
    ) {
      // Blocking on a background command's output is waiting on that command.
      const category = backgroundCategories.get(item.taskId) ?? "waiting";
      claims.push({
        startMs: item.startMs,
        endMs: item.endMs,
        level: 0,
        category: categoryIndex(category),
      });
      continue;
    }
    const category = classifyItem(item);
    if (category === null) continue;
    claims.push({
      startMs: item.startMs,
      endMs: item.endMs,
      // Subagents and delegated tasks run on their own; the parent only waits.
      level: item.type === "subagent" ? 1 : 0,
      category: categoryIndex(category),
    });
  }

  // Claude quotes a command by its Bash `description` when it has one, which the
  // turn item does not keep. Such a report goes to the latest command started
  // before it that still waits for one; commands that never report (servers,
  // watchers) are older and stay unmatched.
  for (const notification of notifications) {
    if (
      usedNotifications.has(notification) ||
      notification.notificationKind !== "background_command" ||
      !SINGLE_COMMAND_REPORT.test(notification.notificationSummary ?? "")
    ) {
      continue;
    }
    const index = unmatched.findLastIndex(({ item }) => item.startMs <= notification.startMs);
    if (index === -1) continue;
    const [{ item, category }] = unmatched.splice(index, 1) as [(typeof unmatched)[number]];
    usedNotifications.add(notification);
    if (stats) stats.matched += 1;
    claimWait(item, category, notification);
  }

  const modelOutput = categoryIndex("modelOutput");
  const idle = categoryIndex("idle");
  const runs = thread.runs.toSorted((left, right) => left.startMs - right.startMs);
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const gap = run.startMs - previousEnd;
    if (gap > 0 && gap <= IDLE_GAP_CAP_MS) {
      claims.push({ startMs: previousEnd, endMs: run.startMs, level: 3, category: idle });
    }
    claims.push({ startMs: run.startMs, endMs: run.endMs, level: 2, category: modelOutput });
    previousEnd = Math.max(previousEnd, run.endMs);
  }
  return claims;
}

/**
 * Bucket edges in epoch ms, ascending: bucket `i` is `[edges[i], edges[i+1])`.
 * `totals` holds `buckets × CATEGORY_COUNT` seconds, row-major by bucket.
 */
export function attributeThread(
  thread: AgentTimeThread,
  edges: ReadonlyArray<number>,
  totals: Float64Array,
  stats?: BackgroundMatchStats,
): void {
  const bucketCount = edges.length - 1;
  if (bucketCount <= 0) return;
  const windowStart = edges[0]!;
  const windowEnd = edges[bucketCount]!;

  const claims = collectClaims(thread, stats).filter(
    (claim) =>
      claim.endMs > claim.startMs && claim.endMs > windowStart && claim.startMs < windowEnd,
  );
  if (claims.length === 0) return;

  // Sweep: +1 at a claim's start, -1 at its end.
  const events: Array<{ readonly at: number; readonly delta: number; readonly claim: Claim }> = [];
  for (const claim of claims) {
    events.push({ at: claim.startMs, delta: 1, claim });
    events.push({ at: claim.endMs, delta: -1, claim });
  }
  events.sort((left, right) => left.at - right.at);

  const counts = new Int32Array(LEVELS * CATEGORY_COUNT);
  const levelCounts = new Int32Array(LEVELS);
  let bucket = 0;
  let index = 0;
  while (index < events.length) {
    const at = events[index]!.at;
    while (index < events.length && events[index]!.at === at) {
      const { delta, claim } = events[index]!;
      counts[claim.level * CATEGORY_COUNT + claim.category]! += delta;
      levelCounts[claim.level]! += delta;
      index += 1;
    }
    if (index >= events.length) break;
    const next = events[index]!.at;
    let level = 0;
    while (level < LEVELS && levelCounts[level] === 0) level += 1;
    if (level === LEVELS) continue;

    const from = Math.max(at, windowStart);
    const to = Math.min(next, windowEnd);
    if (to <= from) continue;
    const share = 1 / levelCounts[level]!;
    while (bucket < bucketCount - 1 && edges[bucket + 1]! <= from) bucket += 1;
    let cursor = from;
    let spanBucket = bucket;
    while (cursor < to) {
      const bucketEnd = Math.min(to, edges[spanBucket + 1]!);
      const seconds = (bucketEnd - cursor) / 1000;
      const row = spanBucket * CATEGORY_COUNT;
      for (let category = 0; category < CATEGORY_COUNT; category += 1) {
        const count = counts[level * CATEGORY_COUNT + category]!;
        if (count > 0) totals[row + category]! += seconds * count * share;
      }
      cursor = bucketEnd;
      spanBucket += 1;
    }
  }
}
