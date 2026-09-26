/**
 * Fork: initiatives ("Vorhaben"). An initiative bundles T3 projects, threads
 * and work without code under one goal. The server keeps them in a store of
 * their own (`initiatives.sqlite`); the Initiatives page reads them through a
 * subscription and changes them through `act`.
 *
 * Every record carries a UUID, a revision and its author, and every change
 * writes an audit row, so a shared store for several people can follow later.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";

export const INITIATIVES_WS_METHODS = {
  subscribeList: "initiatives.subscribeList",
  subscribeDetail: "initiatives.subscribeDetail",
  act: "initiatives.act",
  usage: "initiatives.usage",
} as const;

/**
 * Who wrote a change, derived from the caller, never passed in: `person:<id>`
 * for a user of the app, `role:<role>:<threadId>` for an agent, `system:<job>`
 * for the server itself, `import:<source>` for imported data.
 */
export const InitiativeAuthor = TrimmedNonEmptyString;
export type InitiativeAuthor = typeof InitiativeAuthor.Type;

const RecordBase = {
  id: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: InitiativeAuthor,
  updatedBy: InitiativeAuthor,
};

export const InitiativeStatus = Schema.Literals(["active", "paused", "archived"]);
export type InitiativeStatus = typeof InitiativeStatus.Type;

export const Initiative = Schema.Struct({
  ...RecordBase,
  title: TrimmedNonEmptyString,
  goalText: Schema.String,
  status: InitiativeStatus,
  /** Markdown every thread of the initiative gets in its start prompt. */
  instructionsMd: Schema.String,
  /** The environment that holds the initiative's store, brain and coordinator. */
  homeEnvironmentId: Schema.NullOr(EnvironmentId),
  /** Provider instances that must never work on this initiative. */
  providerExclusions: Schema.Array(TrimmedNonEmptyString),
  /** The pinned coordinator thread, once there is one. */
  coordinatorThreadId: Schema.NullOr(ThreadId),
  /** Stop flag: no new starts while set. */
  halted: Schema.Boolean,
});
export type Initiative = typeof Initiative.Type;

export const InitiativeProject = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  projectId: Schema.NullOr(ProjectId),
  workspaceRoot: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type InitiativeProject = typeof InitiativeProject.Type;

export const InitiativeSessionSource = Schema.Literals([
  "t3",
  "claude-code-cli",
  "claude-desktop",
  "codex",
]);
export type InitiativeSessionSource = typeof InitiativeSessionSource.Type;

/**
 * auto: the initiative started it. suggested: it runs in one of the
 * initiative's projects and waits for the user to confirm. confirmed: the
 * user assigned it. released: the user took it out again; kept so it is not
 * suggested again.
 */
export const InitiativeAssignment = Schema.Literals(["auto", "suggested", "confirmed", "released"]);
export type InitiativeAssignment = typeof InitiativeAssignment.Type;

/**
 * One run of work: a T3 thread, or later an imported Claude Code or Codex
 * session. A session belongs to exactly one initiative at a time.
 */
export const InitiativeSession = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  source: InitiativeSessionSource,
  /** The thread id for T3, the provider's session id for imported sessions. */
  nativeId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  assignment: InitiativeAssignment,
  launchJobId: Schema.NullOr(TrimmedNonEmptyString),
});
export type InitiativeSession = typeof InitiativeSession.Type;

export const InitiativeLaunchStatus = Schema.Literals([
  "created",
  "started",
  "failed",
  "dismissed",
]);
export type InitiativeLaunchStatus = typeof InitiativeLaunchStatus.Type;

export const InitiativeLaunchSpec = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  provider: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  worktree: Schema.Boolean,
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  parentThreadId: Schema.NullOr(ThreadId),
});
export type InitiativeLaunchSpec = typeof InitiativeLaunchSpec.Type;

/**
 * Written before the initiative starts a thread, with the thread's id chosen
 * up front; after a restart the server looks for that thread instead of
 * starting it again.
 */
export const InitiativeLaunchJob = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  /** Idempotency key: a second start with the same key returns this job. */
  key: TrimmedNonEmptyString,
  threadId: ThreadId,
  spec: InitiativeLaunchSpec,
  status: InitiativeLaunchStatus,
  error: Schema.NullOr(Schema.String),
});
export type InitiativeLaunchJob = typeof InitiativeLaunchJob.Type;

export const InitiativeSummary = Schema.Struct({
  initiative: Initiative,
  projects: Schema.Array(InitiativeProject),
  /** Assigned T3 threads, to show their live state from the client's own thread list. */
  threads: Schema.Array(
    Schema.Struct({ environmentId: Schema.NullOr(EnvironmentId), threadId: ThreadId }),
  ),
  sessionCount: NonNegativeInt,
});
export type InitiativeSummary = typeof InitiativeSummary.Type;

export const InitiativesListSnapshot = Schema.Struct({
  initiatives: Schema.Array(InitiativeSummary),
});
export type InitiativesListSnapshot = typeof InitiativesListSnapshot.Type;

export const InitiativeTarget = Schema.Struct({ initiativeId: TrimmedNonEmptyString });
export type InitiativeTarget = typeof InitiativeTarget.Type;

export const InitiativeDetailSnapshot = Schema.Struct({
  initiative: Schema.NullOr(Initiative),
  projects: Schema.Array(InitiativeProject),
  sessions: Schema.Array(InitiativeSession),
  launchJobs: Schema.Array(InitiativeLaunchJob),
});
export type InitiativeDetailSnapshot = typeof InitiativeDetailSnapshot.Type;

const InitiativeRef = { initiativeId: TrimmedNonEmptyString };

export const InitiativesAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    title: TrimmedNonEmptyString,
    goalText: Schema.optional(Schema.String),
    instructionsMd: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    ...InitiativeRef,
    expectedRevision: Schema.optional(NonNegativeInt),
    title: Schema.optional(TrimmedNonEmptyString),
    goalText: Schema.optional(Schema.String),
    instructionsMd: Schema.optional(Schema.String),
    providerExclusions: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  Schema.Struct({ type: Schema.Literals(["archive", "reopen"]), ...InitiativeRef }),
  Schema.Struct({
    type: Schema.Literal("addProject"),
    ...InitiativeRef,
    projectId: ProjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("removeProject"),
    ...InitiativeRef,
    initiativeProjectId: TrimmedNonEmptyString,
  }),
  /** Assigns a thread, or confirms a suggested one; moves it from another initiative. */
  Schema.Struct({
    type: Schema.Literal("assignThread"),
    ...InitiativeRef,
    threadId: ThreadId,
    environmentId: Schema.optional(EnvironmentId),
    /** Shown until the server can read a thread of another environment itself. */
    title: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("unassignThread"),
    ...InitiativeRef,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("startThread"),
    ...InitiativeRef,
    /** Chosen by the client per submit, so a retried request starts nothing twice. */
    key: TrimmedNonEmptyString,
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
    prompt: TrimmedNonEmptyString,
    provider: Schema.optional(TrimmedNonEmptyString),
    model: Schema.optional(TrimmedNonEmptyString),
    worktree: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("dismissLaunch"),
    ...InitiativeRef,
    launchJobId: TrimmedNonEmptyString,
  }),
]);
export type InitiativesAction = typeof InitiativesAction.Type;

export const InitiativesActResult = Schema.Struct({
  /** The id of what the action created or changed. */
  id: Schema.NullOr(Schema.String),
});
export type InitiativesActResult = typeof InitiativesActResult.Type;

export const InitiativeThreadUsage = Schema.Struct({
  threadId: ThreadId,
  /** API-equivalent cost, not what was billed. */
  costUsd: Schema.NullOr(Schema.Number),
  totalTokens: Schema.NullOr(NonNegativeInt),
});
export type InitiativeThreadUsage = typeof InitiativeThreadUsage.Type;

export const InitiativeUsageResult = Schema.Struct({
  threads: Schema.Array(InitiativeThreadUsage),
  readAt: IsoDateTime,
});
export type InitiativeUsageResult = typeof InitiativeUsageResult.Type;

export class InitiativesError extends Schema.TaggedError<InitiativesError>()("InitiativesError", {
  message: Schema.String,
}) {}

const InitiativesRpcError = Schema.Union([InitiativesError, EnvironmentAuthorizationError]);

export const WsInitiativesSubscribeListRpc = Rpc.make(INITIATIVES_WS_METHODS.subscribeList, {
  payload: Schema.Struct({}),
  success: InitiativesListSnapshot,
  error: InitiativesRpcError,
  stream: true,
});

export const WsInitiativesSubscribeDetailRpc = Rpc.make(INITIATIVES_WS_METHODS.subscribeDetail, {
  payload: InitiativeTarget,
  success: InitiativeDetailSnapshot,
  error: InitiativesRpcError,
  stream: true,
});

export const WsInitiativesActRpc = Rpc.make(INITIATIVES_WS_METHODS.act, {
  payload: InitiativesAction,
  success: InitiativesActResult,
  error: InitiativesRpcError,
});

export const WsInitiativesUsageRpc = Rpc.make(INITIATIVES_WS_METHODS.usage, {
  payload: InitiativeTarget,
  success: InitiativeUsageResult,
  error: InitiativesRpcError,
});
