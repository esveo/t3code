/**
 * Fork: initiatives ("Vorhaben"). An initiative bundles T3 projects, threads
 * and work without code under one goal. The server keeps them in a store of
 * their own (`initiatives.sqlite`); the Initiatives page reads them through a
 * subscription and changes them through `act`.
 *
 * Every record carries a UUID, a revision and its author, and every change
 * writes an audit row, so a shared store for several people can follow later.
 */
import * as Effect from "effect/Effect";
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
  brainRead: "initiatives.brainRead",
  subscribeInbox: "initiatives.subscribeInbox",
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

export const InitiativeRoleName = Schema.Literals(["participant", "coordinator"]);
export type InitiativeRoleName = typeof InitiativeRoleName.Type;

export const InitiativeLaunchSpec = Schema.Struct({
  /** A coordinator start makes the thread the initiative's pinned coordinator. */
  role: InitiativeRoleName.pipe(Schema.withDecodingDefault(Effect.succeed("participant" as const))),
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

/**
 * Where a brain page sits: steckbrief (always in the start prompt), index
 * (what exists, read at the start), detail (found by search) or handoff (the
 * coordinator's open tasks, latest results and next step).
 */
export const InitiativeBrainLayer = Schema.Literals(["steckbrief", "index", "detail", "handoff"]);
export type InitiativeBrainLayer = typeof InitiativeBrainLayer.Type;

/**
 * A page of an initiative's brain. The markdown lives in the initiative's own
 * git repository; this record indexes it and carries the lock a person's
 * correction sets, which agents cannot overwrite.
 */
export const InitiativeBrainPage = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  layer: InitiativeBrainLayer,
  title: Schema.String,
  sources: Schema.Array(Schema.String),
  status: Schema.Literals(["current", "outdated", "merged"]),
  /** Set when a person wrote the page; agents then leave it alone. */
  lockedBy: Schema.NullOr(InitiativeAuthor),
  lastCommit: Schema.NullOr(Schema.String),
});
export type InitiativeBrainPage = typeof InitiativeBrainPage.Type;

export const InitiativeBrainCommit = Schema.Struct({
  commit: Schema.String,
  author: Schema.String,
  at: IsoDateTime,
  message: Schema.String,
});
export type InitiativeBrainCommit = typeof InitiativeBrainCommit.Type;

export const InitiativeBrainPageContent = Schema.Struct({
  path: Schema.String,
  markdown: Schema.NullOr(Schema.String),
  history: Schema.Array(InitiativeBrainCommit),
});
export type InitiativeBrainPageContent = typeof InitiativeBrainPageContent.Type;

/**
 * What an entry records. question: something the user answers (the Inbox's
 * decisions and tasks for the user are questions and tasks here); decision:
 * a recorded choice; the rest is the initiative's log.
 */
export const InitiativeEntryType = Schema.Literals([
  "question",
  "decision",
  "assumption",
  "issue",
  "task",
  "plan",
  "idea",
  "insight",
  "risk",
]);
export type InitiativeEntryType = typeof InitiativeEntryType.Type;

/**
 * An Inbox item of a thread: the coordinator it asks for and the item's id
 * there. The full item (options, answer, snooze) is in `details.decision`.
 */
export const InitiativeEntryInbox = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
});
export type InitiativeEntryInbox = typeof InitiativeEntryInbox.Type;

export const InitiativeEntry = Schema.Struct({
  ...RecordBase,
  /** Null for entries of no initiative ("Ohne Zuordnung"). */
  initiativeId: Schema.NullOr(TrimmedNonEmptyString),
  type: InitiativeEntryType,
  title: TrimmedNonEmptyString,
  bodyMd: Schema.String,
  /** Per type, see ENTRY_STATUSES in @t3tools/initiatives/model. */
  status: TrimmedNonEmptyString,
  details: Schema.Record(Schema.String, Schema.Unknown),
  origin: Schema.Struct({
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(Schema.String),
  }),
  /** The entry this one replaces; that one's status becomes superseded. */
  supersedes: Schema.NullOr(TrimmedNonEmptyString),
  inbox: Schema.NullOr(InitiativeEntryInbox),
  urgency: Schema.NullOr(Schema.Literals(["now", "today", "later"])),
  dependsOn: Schema.Array(Schema.String),
  routeToThreadId: Schema.NullOr(ThreadId),
  snoozedAt: Schema.NullOr(IsoDateTime),
  /** Where a migrated entry came from, so a second migration skips it. */
  legacyKey: Schema.NullOr(Schema.String),
});
export type InitiativeEntry = typeof InitiativeEntry.Type;

export const InitiativeEntryLinkKind = Schema.Literals([
  "dependsOn",
  "relatesTo",
  "implements",
  "answers",
  "blocks",
]);
export type InitiativeEntryLinkKind = typeof InitiativeEntryLinkKind.Type;

export const InitiativeEntryLink = Schema.Struct({
  ...RecordBase,
  initiativeId: Schema.NullOr(TrimmedNonEmptyString),
  fromId: TrimmedNonEmptyString,
  toId: TrimmedNonEmptyString,
  kind: InitiativeEntryLinkKind,
});
export type InitiativeEntryLink = typeof InitiativeEntryLink.Type;

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
  brainPages: Schema.Array(InitiativeBrainPage),
  /** Why the brain could not be read or written last, until a write succeeds. */
  brainError: Schema.NullOr(Schema.String),
  entries: Schema.Array(InitiativeEntry),
  links: Schema.Array(InitiativeEntryLink),
});

/**
 * The Inbox over every initiative: what waits on the user. Inbox items group
 * by the initiative their coordinator belongs to now; null is "Ohne Zuordnung".
 */
export const InitiativesInboxSnapshot = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      entry: InitiativeEntry,
      initiativeId: Schema.NullOr(Schema.String),
      initiativeTitle: Schema.NullOr(Schema.String),
    }),
  ),
});
export type InitiativesInboxSnapshot = typeof InitiativesInboxSnapshot.Type;
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
  /**
   * Starts the initiative's coordinator, or a fresh one from the handoff when
   * there is one already: the new thread is pinned, the old one unpinned, and
   * the old coordinator's threads report to the new one.
   */
  Schema.Struct({
    type: Schema.Literal("startCoordinator"),
    ...InitiativeRef,
    key: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
    provider: Schema.optional(TrimmedNonEmptyString),
    model: Schema.optional(TrimmedNonEmptyString),
    /** A first instruction; without it the coordinator continues from the handoff. */
    message: Schema.optional(Schema.String),
  }),
  /** A person's edit of a brain page; it locks the page against agents. */
  Schema.Struct({
    type: Schema.Literal("brainWrite"),
    ...InitiativeRef,
    path: TrimmedNonEmptyString,
    markdown: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("brainUnlock"),
    ...InitiativeRef,
    path: TrimmedNonEmptyString,
  }),
  /** A person's entry; the initiative is null for one of no initiative. */
  Schema.Struct({
    type: Schema.Literal("entryCreate"),
    initiativeId: Schema.NullOr(TrimmedNonEmptyString),
    entryType: InitiativeEntryType,
    title: TrimmedNonEmptyString,
    bodyMd: Schema.optional(Schema.String),
    details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  /** Moves an entry to another status of its type, e.g. a proposed decision to valid. */
  Schema.Struct({
    type: Schema.Literal("entryStatus"),
    entryId: TrimmedNonEmptyString,
    status: TrimmedNonEmptyString,
    note: Schema.optional(Schema.String),
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

export const WsInitiativesSubscribeInboxRpc = Rpc.make(INITIATIVES_WS_METHODS.subscribeInbox, {
  payload: Schema.Struct({}),
  success: InitiativesInboxSnapshot,
  error: InitiativesRpcError,
  stream: true,
});

export const WsInitiativesBrainReadRpc = Rpc.make(INITIATIVES_WS_METHODS.brainRead, {
  payload: Schema.Struct({ initiativeId: TrimmedNonEmptyString, path: TrimmedNonEmptyString }),
  success: InitiativeBrainPageContent,
  error: InitiativesRpcError,
});
