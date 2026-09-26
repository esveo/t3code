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
  subscribeThreadPreflight: "initiatives.subscribeThreadPreflight",
  preflightReport: "initiatives.preflightReport",
  importCatalog: "initiatives.importCatalog",
  statsReport: "initiatives.statsReport",
  statsEstimate: "initiatives.statsEstimate",
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
  /**
   * off: approvals of the initiative's threads are not looked at. shadow: the
   * preflight records what it would have answered, and answers nothing.
   */
  preflightMode: Schema.Literals(["off", "shadow"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("shadow" as const)),
  ),
});
export type Initiative = typeof Initiative.Type;

/** Server-wide switches of the module; one record with id "global". */
export const InitiativeControl = Schema.Struct({
  ...RecordBase,
  /** The global stop: no initiative starts a thread while set. */
  halted: Schema.Boolean,
});
export type InitiativeControl = typeof InitiativeControl.Type;

export const PreflightWouldHave = Schema.Literals(["accept", "decline", "ask"]);
export type PreflightWouldHave = typeof PreflightWouldHave.Type;

/** What a checker would have answered; in shadow mode nothing is sent. */
export const PreflightVerdict = Schema.Struct({
  checker: Schema.Literals(["rules"]),
  ruleVersion: Schema.String,
  ruleHit: Schema.NullOr(Schema.String),
  /** The row of the approval matrix the action falls into. */
  category: Schema.String,
  wouldHave: PreflightWouldHave,
  reason: Schema.String,
  latencyMs: NonNegativeInt,
});
export type PreflightVerdict = typeof PreflightVerdict.Type;

/**
 * An approval request of an initiative thread, as the provider asked it, and
 * how it ended. Secrets in the action are masked; the hash identifies the
 * unchanged action.
 */
export const InitiativeApprovalObservation = Schema.Struct({
  ...RecordBase,
  initiativeId: Schema.NullOr(TrimmedNonEmptyString),
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString,
  provider: Schema.String,
  runtimeMode: Schema.String,
  requestType: Schema.String,
  action: Schema.Struct({
    tool: Schema.NullOr(Schema.String),
    command: Schema.NullOr(Schema.String),
    paths: Schema.Array(Schema.String),
    detail: Schema.NullOr(Schema.String),
    input: Schema.NullOr(Schema.String),
  }),
  actionHash: Schema.String,
  providerWarning: Schema.NullOr(Schema.String),
  openedAt: IsoDateTime,
  resolvedBy: Schema.NullOr(Schema.Literals(["person", "provider-auto", "expired"])),
  decision: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(IsoDateTime),
  verdicts: Schema.Array(PreflightVerdict),
  /** The user marked the verdict as wrong; it counts against the checker. */
  markedWrongBy: Schema.NullOr(InitiativeAuthor),
});
export type InitiativeApprovalObservation = typeof InitiativeApprovalObservation.Type;

export const PreflightProviderStats = Schema.Struct({
  provider: Schema.String,
  requests: NonNegativeInt,
  /** Answered by the user; with the thread in auto mode that is what landed on them despite it. */
  byPerson: NonNegativeInt,
  inAutoMode: NonNegativeInt,
  perHour: Schema.NullOr(Schema.Number),
  /** Of the requests the user answered: the verdict matched their answer. */
  agreed: NonNegativeInt,
  /** The verdict would have accepted what the user declined. */
  wrongAccepts: NonNegativeInt,
  /** The verdict would have asked about what the user accepted. */
  needlessAsks: NonNegativeInt,
  markedWrong: NonNegativeInt,
});
export type PreflightProviderStats = typeof PreflightProviderStats.Type;

export const PreflightReport = Schema.Struct({
  providers: Schema.Array(PreflightProviderStats),
  observations: Schema.Array(InitiativeApprovalObservation),
});
export type PreflightReport = typeof PreflightReport.Type;

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
  /** When the session ran; known for imported ones, a T3 thread shows its own. */
  startedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  endedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  prUrls: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  model: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  tokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** One or two sentences, made on request; the user reads it before it goes anywhere. */
  summary: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type InitiativeSession = typeof InitiativeSession.Type;

export const InitiativeImportSource = Schema.Literals([
  "t3",
  "claude-code-cli",
  "claude-desktop",
  "codex",
]);
export type InitiativeImportSource = typeof InitiativeImportSource.Type;

/** A folder the sessions of a source ran in, with how many and when. */
export const InitiativeImportGroup = Schema.Struct({
  source: InitiativeImportSource,
  cwd: Schema.String,
  count: NonNegativeInt,
  firstAt: Schema.NullOr(IsoDateTime),
  lastAt: Schema.NullOr(IsoDateTime),
  /** Inside one of the initiative's projects. */
  preselected: Schema.Boolean,
  /** Already in this initiative. */
  imported: NonNegativeInt,
  /** Held by another initiative. */
  elsewhere: NonNegativeInt,
});
export type InitiativeImportGroup = typeof InitiativeImportGroup.Type;

export const InitiativeImportCatalog = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      source: InitiativeImportSource,
      available: Schema.Boolean,
      note: Schema.String,
    }),
  ),
  groups: Schema.Array(InitiativeImportGroup),
});
export type InitiativeImportCatalog = typeof InitiativeImportCatalog.Type;

export const InitiativeImportSelection = Schema.Struct({
  source: InitiativeImportSource,
  cwd: Schema.String,
});
export type InitiativeImportSelection = typeof InitiativeImportSelection.Type;

/**
 * A resumable import: first the metadata of the chosen folders' sessions,
 * or later summaries of chosen sessions within a cost cap.
 */
export const InitiativeImportJob = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  phase: Schema.Literals(["metadata", "summary"]),
  selection: Schema.Array(InitiativeImportSelection),
  sessionIds: Schema.Array(Schema.String),
  status: Schema.Literals(["running", "paused", "cancelled", "done", "failed"]),
  total: NonNegativeInt,
  done: NonNegativeInt,
  added: NonNegativeInt,
  skipped: NonNegativeInt,
  /** Position of the next item, so a paused job continues where it stopped. */
  cursor: NonNegativeInt,
  costCapUsd: Schema.NullOr(Schema.Number),
  spentUsd: Schema.Number,
  error: Schema.NullOr(Schema.String),
});
export type InitiativeImportJob = typeof InitiativeImportJob.Type;

/** New sessions of a source in this folder join the initiative on their own; can be turned off. */
export const InitiativeAutoAssignRule = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  source: InitiativeImportSource,
  cwdPrefix: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type InitiativeAutoAssignRule = typeof InitiativeAutoAssignRule.Type;

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

/**
 * What one session took: tokens and API-equivalent cost from the provider's
 * transcripts, run time and turns from the thread, how it ended.
 */
export const InitiativeSessionStats = Schema.Struct({
  ...RecordBase,
  initiativeId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  provider: Schema.String,
  model: Schema.NullOr(Schema.String),
  taskType: Schema.NullOr(Schema.String),
  roleId: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(
    Schema.Struct({
      input: NonNegativeInt,
      output: NonNegativeInt,
      cacheRead: NonNegativeInt,
      cacheWrite: NonNegativeInt,
    }),
  ),
  /** API-equivalent, not what a subscription billed. */
  apiUsd: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(NonNegativeInt),
  turns: Schema.NullOr(NonNegativeInt),
  outcome: Schema.NullOr(Schema.Literals(["done", "rework", "cancelled"])),
  measuredAt: IsoDateTime,
});
export type InitiativeSessionStats = typeof InitiativeSessionStats.Type;

/** A provider's quota window as it stood at one moment, per account. */
export const InitiativeQuotaObservation = Schema.Struct({
  ...RecordBase,
  provider: Schema.String,
  accountId: Schema.String,
  windowId: Schema.String,
  windowKind: Schema.String,
  windowLabel: Schema.String,
  resetsAt: Schema.NullOr(IsoDateTime),
  windowDurationMins: Schema.NullOr(NonNegativeInt),
  usedPercent: Schema.Number,
  checkedAt: IsoDateTime,
  quality: Schema.Literals(["ok", "partial", "unavailable"]),
});
export type InitiativeQuotaObservation = typeof InitiativeQuotaObservation.Type;

const RangeSchema = Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number]));

export const InitiativeStatsEstimate = Schema.Struct({
  basis: NonNegativeInt,
  match: Schema.Literals(["same-model", "same-provider"]),
  apiUsd: RangeSchema,
  tokens: RangeSchema,
  durationMs: RangeSchema,
  turns: RangeSchema,
});
export type InitiativeStatsEstimate = typeof InitiativeStatsEstimate.Type;

/** A quota window now and the initiative's estimated share of it. */
export const InitiativeQuotaShare = Schema.Struct({
  provider: Schema.String,
  accountId: Schema.String,
  windowId: Schema.String,
  windowKind: Schema.String,
  windowLabel: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  checkedAt: IsoDateTime,
  quality: Schema.Literals(["ok", "partial", "unavailable"]),
  method: Schema.Literal("delta"),
  /** Estimated percentage points of the window this initiative used this period. */
  initiativePercent: Schema.Number,
  otherInitiativesPercent: Schema.Number,
  /** What no measured session explains: other threads, the CLI, the desktop app, gaps. */
  unattributedPercent: Schema.Number,
  confidence: Schema.Literals(["low", "medium"]),
  observations: NonNegativeInt,
});
export type InitiativeQuotaShare = typeof InitiativeQuotaShare.Type;

export const InitiativeStatsReport = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      title: Schema.String,
      stats: InitiativeSessionStats,
      /** What similar sessions took, leaving this one out: the estimate beside the actual. */
      estimate: Schema.NullOr(InitiativeStatsEstimate),
    }),
  ),
  quota: Schema.Array(InitiativeQuotaShare),
  measuredAt: Schema.NullOr(IsoDateTime),
});
export type InitiativeStatsReport = typeof InitiativeStatsReport.Type;

export const InitiativeStatsEstimateResult = Schema.Struct({
  estimate: Schema.NullOr(InitiativeStatsEstimate),
  /** The provider's windows now, to compare the estimate with what is left. */
  quota: Schema.Array(InitiativeQuotaShare),
});
export type InitiativeStatsEstimateResult = typeof InitiativeStatsEstimateResult.Type;

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
  /** The global stop of all initiatives. */
  halted: Schema.Boolean,
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
  importJobs: Schema.Array(InitiativeImportJob),
  autoAssignRules: Schema.Array(InitiativeAutoAssignRule),
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
  /** The stop of one initiative, or with initiativeId null of all of them. */
  Schema.Struct({
    type: Schema.Literal("setHalt"),
    initiativeId: Schema.NullOr(TrimmedNonEmptyString),
    halted: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("setPreflightMode"),
    ...InitiativeRef,
    mode: Schema.Literals(["off", "shadow"]),
  }),
  /** Marks the preflight's verdict on a request as wrong, or takes that back. */
  Schema.Struct({
    type: Schema.Literal("preflightMarkWrong"),
    observationId: TrimmedNonEmptyString,
    wrong: Schema.Boolean,
  }),
  /** Imports the metadata of the chosen folders' sessions; nothing without a selection. */
  Schema.Struct({
    type: Schema.Literal("importRun"),
    ...InitiativeRef,
    selection: Schema.NonEmptyArray(InitiativeImportSelection),
    /** Later sessions of these folders join the initiative on their own. */
    autoAssign: Schema.optional(Schema.Boolean),
  }),
  /** Summaries of imported sessions, on request, until the cost cap. */
  Schema.Struct({
    type: Schema.Literal("importSummarize"),
    ...InitiativeRef,
    sessionIds: Schema.NonEmptyArray(TrimmedNonEmptyString),
    costCapUsd: Schema.Number.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    type: Schema.Literals(["importPause", "importResume", "importCancel"]),
    ...InitiativeRef,
    jobId: TrimmedNonEmptyString,
  }),
  /** Takes imported sessions out again: those of one folder, or all of a source. */
  Schema.Struct({
    type: Schema.Literal("importRemove"),
    ...InitiativeRef,
    source: InitiativeImportSource,
    cwd: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("autoAssignRuleSet"),
    ...InitiativeRef,
    ruleId: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  /** Measures the initiative's sessions again and records the providers' quota. */
  Schema.Struct({ type: Schema.Literal("statsRefresh"), ...InitiativeRef }),
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

/** The approvals of one thread, for the preflight's verdict beside the approval card. */
export const WsInitiativesSubscribeThreadPreflightRpc = Rpc.make(
  INITIATIVES_WS_METHODS.subscribeThreadPreflight,
  {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Struct({ observations: Schema.Array(InitiativeApprovalObservation) }),
    error: InitiativesRpcError,
    stream: true,
  },
);

/** The preflight's record of one initiative, or of all with initiativeId null. */
export const WsInitiativesPreflightReportRpc = Rpc.make(INITIATIVES_WS_METHODS.preflightReport, {
  payload: Schema.Struct({ initiativeId: Schema.NullOr(TrimmedNonEmptyString) }),
  success: PreflightReport,
  error: InitiativesRpcError,
});

/** What earlier work there is to import, per source and folder. Reads local session files. */
export const WsInitiativesImportCatalogRpc = Rpc.make(INITIATIVES_WS_METHODS.importCatalog, {
  payload: InitiativeTarget,
  success: InitiativeImportCatalog,
  error: InitiativesRpcError,
});

export const WsInitiativesStatsReportRpc = Rpc.make(INITIATIVES_WS_METHODS.statsReport, {
  payload: InitiativeTarget,
  success: InitiativeStatsReport,
  error: InitiativesRpcError,
});

/** What a new session on this provider and model would likely take, before it starts. */
export const WsInitiativesStatsEstimateRpc = Rpc.make(INITIATIVES_WS_METHODS.statsEstimate, {
  payload: Schema.Struct({
    initiativeId: Schema.NullOr(TrimmedNonEmptyString),
    provider: TrimmedNonEmptyString,
    model: Schema.NullOr(TrimmedNonEmptyString),
  }),
  success: InitiativeStatsEstimateResult,
  error: InitiativesRpcError,
});

export const WsInitiativesBrainReadRpc = Rpc.make(INITIATIVES_WS_METHODS.brainRead, {
  payload: Schema.Struct({ initiativeId: TrimmedNonEmptyString, path: TrimmedNonEmptyString }),
  success: InitiativeBrainPageContent,
  error: InitiativesRpcError,
});
