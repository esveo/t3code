/**
 * Fork: where agents spend their time, for the Usage page's "Agent time" chart.
 *
 * The environment reads its own thread history, attributes each thread's
 * wall-clock time to a fixed set of categories, and returns only per-bucket
 * totals. Raw turn items never cross the wire.
 *
 * @module agentTime
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ForwardCompatibleArray, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageDay, UsageResolution } from "./usage.ts";

export const AGENT_TIME_WS_METHODS = {
  summary: "agentTime.summary",
} as const;

/** Fixed categories, in the order the chart stacks them. */
export const AGENT_TIME_CATEGORIES = [
  "modelThinking",
  "modelOutput",
  "tests",
  "build",
  "gitCi",
  "database",
  "browser",
  "jobs",
  "files",
  "otherTools",
  "waiting",
  "compactionErrors",
  "children",
  "idle",
] as const;
export const AgentTimeCategory = Schema.Literals(AGENT_TIME_CATEGORIES);
export type AgentTimeCategory = typeof AgentTimeCategory.Type;

/** Not active work: hidden from the chart by default and left out of active totals. */
export const AGENT_TIME_PASSIVE_CATEGORIES: ReadonlySet<AgentTimeCategory> = new Set([
  "children",
  "idle",
]);

export const AgentTimeSummaryInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /** IANA zone the client wants days bucketed in. */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  /** Inclusive UTC instant of an hourly rolling window. */
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  /** Exclusive UTC instant of an hourly rolling window. */
  untilTime: Schema.optional(TrimmedNonEmptyString),
  /** Only this project's threads; all projects when absent. */
  projectId: Schema.optional(ProjectId),
});
export type AgentTimeSummaryInput = typeof AgentTimeSummaryInput.Type;

export const AgentTimeCategorySeconds = Schema.Struct({
  category: AgentTimeCategory,
  seconds: Schema.Number,
});
export type AgentTimeCategorySeconds = typeof AgentTimeCategorySeconds.Type;

export const AgentTimeBucket = Schema.Struct({
  /** `YYYY-MM-DD` for daily buckets, the hour's start instant for hourly ones. */
  start: TrimmedNonEmptyString,
  categories: ForwardCompatibleArray(AgentTimeCategorySeconds),
});
export type AgentTimeBucket = typeof AgentTimeBucket.Type;

export const AgentTimeProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  /** Active seconds in the window, for ordering the project filter. */
  activeSeconds: Schema.Number,
});
export type AgentTimeProject = typeof AgentTimeProject.Type;

export const AgentTimeSummary = Schema.Struct({
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  resolution: UsageResolution,
  buckets: ForwardCompatibleArray(AgentTimeBucket),
  /** Every project with agent time in the window, whatever the filter. */
  projects: ForwardCompatibleArray(AgentTimeProject),
  scanDurationMs: Schema.Number,
});
export type AgentTimeSummary = typeof AgentTimeSummary.Type;

export class AgentTimeReadError extends Schema.TaggedError<AgentTimeReadError>()(
  "AgentTimeReadError",
  {
    reason: Schema.Literals(["readFailed", "invalidWindow", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent time could not be read (${this.reason}).`;
  }
}

export const WsAgentTimeSummaryRpc = Rpc.make(AGENT_TIME_WS_METHODS.summary, {
  payload: AgentTimeSummaryInput,
  success: AgentTimeSummary,
  error: Schema.Union([AgentTimeReadError, EnvironmentAuthorizationError]),
});
