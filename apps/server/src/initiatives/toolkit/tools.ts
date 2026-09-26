/**
 * Fork: the MCP tools of initiatives. Every thread sees them; each call checks
 * the caller's profile on the server (INITIATIVE_TOOL_PROFILES): a thread of
 * an initiative may read it, its coordinator may also change it and start
 * threads in it. The author of a change is the calling thread, never a
 * parameter.
 */
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { isOrchestrationToolOn } from "../../mcp/McpOrchestrationTools.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

// Initiatives build on thread orchestration and follow its switch (Settings).
const whileOn = () => isOrchestrationToolOn("threads");

export class InitiativeToolError extends Schema.TaggedError<InitiativeToolError>()(
  "InitiativeToolError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const initiativeIdParameter = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Id of the initiative, from initiative_list. Defaults to this thread's initiative.",
  }),
);

export const InitiativeListEntry = Schema.Struct({
  initiativeId: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  status: Schema.String,
  sessions: Schema.Int,
  yours: Schema.Boolean.annotate({ description: "True for the initiative this thread works on." }),
});

export const InitiativeBrief = Schema.Struct({
  initiativeId: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  status: Schema.String,
  instructions: Schema.String,
  role: Schema.Literals(["participant", "coordinator"]).annotate({
    description: "This thread's role in the initiative.",
  }),
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.NullOr(Schema.String),
      label: Schema.String,
      workspaceRoot: Schema.String,
    }),
  ),
  providerExclusions: Schema.Array(Schema.String),
  halted: Schema.Boolean,
});

export const InitiativeSessionEntry = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  link: Schema.NullOr(Schema.String).annotate({
    description: "Markdown link to show the thread to the user.",
  }),
  state: Schema.String.annotate({
    description:
      "running, waiting (on the user), stalled (no change for 30 minutes), review, done, stopped, failed or unknown.",
  }),
  assignment: Schema.String,
  branch: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(Schema.String),
});

// Annotations keep the tool's type; the casts only restore what the generic hides.
const readOnly = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(McpSchema.EnabledWhen, whileOn) as T;

const writing = <T extends Tool.Any>(tool: T, idempotent: boolean): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, idempotent)
    .annotate(Tool.OpenWorld, false)
    .annotate(McpSchema.EnabledWhen, whileOn) as T;

const InitiativeListTool = readOnly(
  Tool.make("initiative_list", {
    description:
      "List the initiatives (Vorhaben) of this environment: goals that bundle projects, threads and work without code.",
    parameters: Schema.Struct({
      includeArchived: Schema.optional(
        Schema.Boolean.annotate({ description: "Defaults to false." }),
      ),
    }),
    success: Schema.Struct({ initiatives: Schema.Array(InitiativeListEntry) }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "List initiatives"),
);

const InitiativeBriefTool = readOnly(
  Tool.make("initiative_brief", {
    description:
      "Read the brief of this thread's initiative: goal, instructions, projects and your role. Read it again when you are unsure what the initiative is after; it may have changed since you started.",
    parameters: Schema.Struct({ initiativeId: initiativeIdParameter }),
    success: InitiativeBrief,
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Read the initiative's brief"),
);

const InitiativeStatusTool = readOnly(
  Tool.make("initiative_status", {
    description:
      "How the initiative's work stands: how many threads run, wait on the user or are stalled, and starts that failed.",
    parameters: Schema.Struct({ initiativeId: initiativeIdParameter }),
    success: Schema.Struct({
      title: Schema.String,
      counts: Schema.Record(Schema.String, Schema.Int),
      failedStarts: Schema.Array(Schema.Struct({ title: Schema.String, error: Schema.String })),
    }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Initiative status"),
);

const SessionListTool = readOnly(
  Tool.make("session_list", {
    description:
      "List the sessions (threads) of the initiative with their state, branch and pull requests, to see what others already work on.",
    parameters: Schema.Struct({
      initiativeId: initiativeIdParameter,
      includeReleased: Schema.optional(
        Schema.Boolean.annotate({ description: "Also list threads taken out of the initiative." }),
      ),
    }),
    success: Schema.Struct({ sessions: Schema.Array(InitiativeSessionEntry) }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "List the initiative's sessions"),
);

const InitiativeCreateTool = writing(
  Tool.make("initiative_create", {
    description:
      "Create an initiative, only when the user asked for one. It starts without projects; the user adds them on the Initiatives page.",
    parameters: Schema.Struct({
      title: TrimmedNonEmptyString,
      goal: Schema.optional(Schema.String),
      instructions: Schema.optional(
        Schema.String.annotate({
          description: "Markdown every thread of the initiative gets at its start.",
        }),
      ),
    }),
    success: Schema.Struct({ initiativeId: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Create an initiative"),
  false,
);

const InitiativeUpdateTool = writing(
  Tool.make("initiative_update", {
    description:
      "Change the brief of the initiative you coordinate: title, goal, instructions, or add providers to exclude. Exclusions can only be added here; only the user removes one.",
    parameters: Schema.Struct({
      title: Schema.optional(TrimmedNonEmptyString),
      goal: Schema.optional(Schema.String),
      instructions: Schema.optional(Schema.String),
      excludeProviders: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
    success: Schema.Struct({ revision: Schema.Int }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Update the initiative"),
  true,
);

const InitiativeArchiveTool = writing(
  Tool.make("initiative_archive", {
    description:
      "Archive the initiative you coordinate once its goal is reached or dropped, when the user agreed. initiative_reopen brings it back.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Archive the initiative"),
  true,
);

const InitiativeReopenTool = writing(
  Tool.make("initiative_reopen", {
    description: "Reopen the archived initiative you coordinate.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Reopen the initiative"),
  true,
);

const InitiativeStartThreadTool = writing(
  Tool.make("initiative_start_thread", {
    description:
      "Start a thread for the initiative you coordinate: it gets the initiative's brief ahead of your prompt, runs in auto mode, reports to you like a thread from start_thread and is listed in the initiative. Pass a key to make the call safe to repeat.",
    parameters: Schema.Struct({
      title: TrimmedNonEmptyString,
      prompt: TrimmedNonEmptyString.annotate({
        description: "The task, with everything the thread needs; it starts without your context.",
      }),
      project: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description:
            "Project id or title from initiative_brief's projects. Defaults to the first one.",
        }),
      ),
      provider: Schema.optional(TrimmedNonEmptyString),
      model: Schema.optional(TrimmedNonEmptyString),
      worktree: Schema.optional(Schema.Boolean.annotate({ description: "Defaults to true." })),
      baseBranch: Schema.optional(TrimmedNonEmptyString),
      key: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description:
            "A key you choose for this start, for example the task's id. Calling again with the same key returns the same thread instead of starting another.",
        }),
      ),
    }),
    success: Schema.Struct({ threadId: Schema.String, link: Schema.String, status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Start a thread for the initiative"),
  true,
);

const SessionAssignTool = writing(
  Tool.make("session_assign", {
    description:
      "Assign an existing thread to the initiative you coordinate, when the user asked for it; a thread belongs to one initiative at a time, so this moves it.",
    parameters: Schema.Struct({ threadId: TrimmedNonEmptyString }),
    success: Schema.Struct({ assigned: Schema.Boolean }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Assign a thread"),
  true,
);

const SessionUnassignTool = writing(
  Tool.make("session_unassign", {
    description: "Take a thread out of the initiative you coordinate.",
    parameters: Schema.Struct({ threadId: TrimmedNonEmptyString }),
    success: Schema.Struct({ unassigned: Schema.Boolean }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Unassign a thread"),
  true,
);

export const InitiativesToolkit = Toolkit.make(
  InitiativeListTool,
  InitiativeBriefTool,
  InitiativeStatusTool,
  SessionListTool,
  InitiativeCreateTool,
  InitiativeUpdateTool,
  InitiativeArchiveTool,
  InitiativeReopenTool,
  InitiativeStartThreadTool,
  SessionAssignTool,
  SessionUnassignTool,
);
