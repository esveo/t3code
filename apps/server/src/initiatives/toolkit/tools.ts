/**
 * Fork: the MCP tools of initiatives. Every thread sees them; each call checks
 * the caller's profile on the server (INITIATIVE_TOOL_PROFILES): a thread of
 * an initiative may read it, its coordinator may also change it and start
 * threads in it. The author of a change is the calling thread, never a
 * parameter.
 */
import { InitiativeStatsEstimateResult, TrimmedNonEmptyString } from "@t3tools/contracts";
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
    success: Schema.Struct({ status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Archive the initiative"),
  true,
);

const InitiativeReopenTool = writing(
  Tool.make("initiative_reopen", {
    description: "Reopen the archived initiative you coordinate.",
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
      taskId: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description:
            "Entry id of the task this thread does. The thread gets the task's acceptance check ahead of the prompt, and a return of the task goes back to it.",
        }),
      ),
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

const BrainReadTool = readOnly(
  Tool.make("brain_read", {
    description:
      "Read a page of the initiative's brain, its shared memory that every agent of the initiative reads: steckbrief.md (the brief), index.md (one line per page), handoff.md (the coordinator's open tasks and next step) or a page under details/. Defaults to index.md.",
    parameters: Schema.Struct({
      path: Schema.optional(
        TrimmedNonEmptyString.annotate({ description: "For example details/api.md." }),
      ),
    }),
    success: Schema.Struct({
      path: Schema.String,
      markdown: Schema.NullOr(Schema.String),
      lockedBy: Schema.NullOr(Schema.String).annotate({
        description: "Set when a person corrected the page; agents then leave it as it is.",
      }),
      history: Schema.Array(
        Schema.Struct({ author: Schema.String, at: Schema.String, message: Schema.String }),
      ),
    }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Read a brain page"),
);

const BrainSearchTool = readOnly(
  Tool.make("brain_search", {
    description:
      "Search the initiative's brain for a word or phrase, ignoring case. Search before you ask the user something the initiative may already know.",
    parameters: Schema.Struct({
      query: TrimmedNonEmptyString,
      limit: Schema.optional(
        Schema.Int.annotate({ description: "Most hits to return. Defaults to 30." }),
      ),
    }),
    success: Schema.Struct({
      hits: Schema.Array(
        Schema.Struct({ path: Schema.String, line: Schema.Int, text: Schema.String }),
      ),
    }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Search the brain"),
);

const BrainWriteTool = writing(
  Tool.make("brain_write", {
    description:
      "Write a page of the brain you coordinate; it is committed to the brain's git history. Keep index.md listing every detail page with one line each. A page a person corrected stays locked against agents: ask the user instead. Write the handoff with handoff_update, not here.",
    parameters: Schema.Struct({
      path: TrimmedNonEmptyString.annotate({
        description: "steckbrief.md, index.md or details/<name>.md.",
      }),
      markdown: Schema.String.annotate({ description: "The whole page." }),
      sources: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description: "Where the knowledge comes from: thread links, pull requests, files.",
        }),
      ),
    }),
    success: Schema.Struct({ path: Schema.String, changed: Schema.Boolean }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Write a brain page"),
  true,
);

const HandoffUpdateTool = writing(
  Tool.make("handoff_update", {
    description:
      "Record the handoff at the end of every turn: open tasks, the latest results and the next step. A fresh coordinator starts from it without this chat, so write what it needs to continue.",
    parameters: Schema.Struct({
      openTasks: Schema.Array(Schema.String),
      lastResults: Schema.Array(Schema.String).annotate({
        description: "What threads reported, one entry each; it is quoted as data.",
      }),
      nextStep: Schema.String,
    }),
    success: Schema.Struct({ changed: Schema.Boolean }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Update the handoff"),
  true,
);

const BrainTidyTool = readOnly(
  Tool.make("brain_tidy", {
    description:
      "What to tidy in the brain: detail pages index.md does not list, index entries without a page, outdated pages and pages a person locked. It changes nothing.",
    success: Schema.Struct({
      notInIndex: Schema.Array(Schema.String),
      missingFromBrain: Schema.Array(Schema.String),
      outdated: Schema.Array(Schema.String),
      locked: Schema.Array(Schema.String),
    }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Suggest brain tidying"),
);

const AcceptanceCheckParameter = Schema.Struct({
  kind: Schema.Literals(["command", "mergedPr", "criterion"]).annotate({
    description:
      "command: a command whose output shows the result (test, build, workflow run); mergedPr: a pull request is merged; criterion: a condition anyone can check by reading the result.",
  }),
  description: TrimmedNonEmptyString.annotate({
    description: "What the check shows, in one sentence. It must be able to fail.",
  }),
  ref: Schema.optional(
    Schema.String.annotate({
      description: "command: the command to run. mergedPr: the pull request's link, once known.",
    }),
  ),
  expected: Schema.optional(
    Schema.String.annotate({
      description: "command: what its output shows when the check passes, e.g. '0 failed'.",
    }),
  ),
});

const EntryTypeParameter = Schema.Literals([
  "decision",
  "assumption",
  "issue",
  "task",
  "plan",
  "idea",
  "insight",
  "risk",
]);

export const EntrySummary = Schema.Struct({
  entryId: Schema.String,
  type: Schema.String,
  title: Schema.String,
  status: Schema.String,
  body: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.String,
  supersedes: Schema.NullOr(Schema.String),
  needsReview: Schema.Boolean.annotate({
    description: "A decision whose assumption was refuted; check whether it still holds.",
  }),
  inbox: Schema.Boolean.annotate({
    description: "An Inbox item for the user; answer it through the Inbox, not entry_status.",
  }),
  check: Schema.NullOr(Schema.String).annotate({
    description:
      "A task's or plan's acceptance check and where it stands: missing, pending, passed, failed or acceptedWithout.",
  }),
  attempts: Schema.Int.annotate({ description: "How often the task went back for a correction." }),
  threadId: Schema.NullOr(Schema.String).annotate({ description: "The thread doing the task." }),
});

const QuestionAskTool = writing(
  Tool.make("question_ask", {
    description:
      "Ask the user a question of the initiative. It goes to the Inbox of the initiative's coordinator (or yours when there is none) and stays there until answered; the answer reaches the coordinator, which passes it on. Give options when the user picks one.",
    parameters: Schema.Struct({
      id: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description: "A stable id you choose; asking again with it updates the question.",
        }),
      ),
      title: TrimmedNonEmptyString,
      question: TrimmedNonEmptyString,
      context: Schema.optional(Schema.String),
      options: Schema.optional(
        Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, label: TrimmedNonEmptyString })),
      ),
      urgency: Schema.optional(Schema.Literals(["now", "today", "later"])),
    }),
    success: Schema.Struct({ questionId: Schema.String, inboxThreadId: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Ask the user"),
  true,
);

const EntryCreateTool = writing(
  Tool.make("entry_create", {
    description:
      "Record an entry in the initiative's log: an issue or an assumption (every thread), or as the coordinator also a task, plan, idea, insight, risk or decision (proposed until the user confirms it). For a decision prefer decision_record, for a question to the user question_ask.",
    parameters: Schema.Struct({
      type: EntryTypeParameter,
      title: TrimmedNonEmptyString,
      body: Schema.optional(Schema.String.annotate({ description: "Markdown." })),
      details: Schema.optional(
        Schema.Record(Schema.String, Schema.Unknown).annotate({
          description:
            "Type-specific fields, e.g. assumption: confidence, howToVerify; issue: githubUrl; task: deadline.",
        }),
      ),
      acceptanceCheck: Schema.optional(
        AcceptanceCheckParameter.annotate({
          description:
            "For a task or plan: the check that shows it is done, fixed now, before the work starts.",
        }),
      ),
    }),
    success: Schema.Struct({ entryId: Schema.String, status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Record an entry"),
  false,
);

const EntryListTool = readOnly(
  Tool.make("entry_list", {
    description:
      "List the initiative's entries, newest first: open ones by default. Read decisions and assumptions before you decide something the initiative may have settled.",
    parameters: Schema.Struct({
      type: Schema.optional(Schema.Literals(["question", ...EntryTypeParameter.literals])),
      status: Schema.optional(TrimmedNonEmptyString),
      includeClosed: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Struct({ entries: Schema.Array(EntrySummary) }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "List entries"),
);

const DecisionRecordTool = writing(
  Tool.make("decision_record", {
    description:
      "Record a decision of the initiative you coordinate, with its context, the options, the choice and why. It stays proposed until the user makes it valid in the Inbox.",
    parameters: Schema.Struct({
      title: TrimmedNonEmptyString,
      context: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Array(Schema.String)),
      choice: TrimmedNonEmptyString,
      rationale: Schema.optional(Schema.String),
      reversalCost: Schema.optional(Schema.Literals(["low", "medium", "high"])),
      technical: Schema.optional(
        Schema.Boolean.annotate({ description: "True for an architecture decision (ADR)." }),
      ),
      adrRef: Schema.optional(
        Schema.String.annotate({ description: "Path of its ADR in the repository." }),
      ),
      dependsOn: Schema.optional(
        Schema.Array(TrimmedNonEmptyString).annotate({
          description:
            "Entry ids of the assumptions it rests on; refuting one marks it for review.",
        }),
      ),
    }),
    success: Schema.Struct({ entryId: Schema.String, status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Record a decision"),
  false,
);

const DecisionReopenTool = writing(
  Tool.make("decision_reopen", {
    description:
      "Reopen a decision of your initiative that no longer holds, with the reason; then record the new one or ask the user.",
    parameters: Schema.Struct({ entryId: TrimmedNonEmptyString, reason: TrimmedNonEmptyString }),
    success: Schema.Struct({ status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Reopen a decision"),
  true,
);

const EntrySupersedeTool = writing(
  Tool.make("entry_supersede", {
    description:
      "Replace an entry of your initiative with a new version instead of changing it: the old one stays in the history as superseded.",
    parameters: Schema.Struct({
      entryId: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      body: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    success: Schema.Struct({ entryId: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Supersede an entry"),
  false,
);

const EntryLinkTool = writing(
  Tool.make("entry_link", {
    description:
      "Link two entries of your initiative: dependsOn (a decision on an assumption), implements (a task for a decision), answers, blocks or relatesTo.",
    parameters: Schema.Struct({
      fromId: TrimmedNonEmptyString,
      toId: TrimmedNonEmptyString,
      kind: Schema.Literals(["dependsOn", "relatesTo", "implements", "answers", "blocks"]),
    }),
    success: Schema.Struct({ linked: Schema.Boolean }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Link entries"),
  true,
);

const EntryStatusTool = writing(
  Tool.make("entry_status", {
    description:
      "Move an entry of your initiative on: an assumption to confirmed or refuted, an issue or task to done, a risk to mitigated. Only the user makes a decision valid.",
    parameters: Schema.Struct({
      entryId: TrimmedNonEmptyString,
      status: TrimmedNonEmptyString,
      note: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({ status: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Change an entry's status"),
  true,
);

const StatsEstimateTool = readOnly(
  Tool.make("stats_estimate", {
    description:
      "Estimate what a thread on a provider and model will take, from the finished sessions of all initiatives (API-equivalent USD, tokens, run time, turns as a middle range), with the provider's quota windows now and this initiative's estimated share of them. Use it before starting larger work; the numbers are estimates.",
    parameters: Schema.Struct({
      provider: TrimmedNonEmptyString.annotate({
        description: "Provider instance id, for example codex or claudeAgent.",
      }),
      model: Schema.optional(TrimmedNonEmptyString),
    }),
    success: InitiativeStatsEstimateResult,
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Estimate a thread's cost"),
);

// ── Loops: check first, return one unit, rollbacks ──────────────────────

const CheckDefineTool = writing(
  Tool.make("check_define", {
    description:
      "Set the acceptance check of a task or plan of the initiative you coordinate, before its work starts: a command with its expected output, a merged pull request, or a checkable criterion. It must be able to fail. A task is done only once its check passed.",
    parameters: Schema.Struct({
      entryId: TrimmedNonEmptyString,
      ...AcceptanceCheckParameter.fields,
    }),
    success: Schema.Struct({ entryId: Schema.String }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Define an acceptance check"),
  true,
);

const CheckReportTool = writing(
  Tool.make("check_report", {
    description: `Report the result of a task's or plan's acceptance check, with evidence: the output excerpt that shows the expected result, the link to the merged pull request, or the commit that meets the criterion. "No error occurred" is not a pass: report passed only when the check itself showed it, and failed when it did not run or showed something else. A failure reported by another thread than the one doing the task sends the task back to that thread. A passed check does not finish the task by itself: the coordinator then moves it to done with entry_status.`,
    parameters: Schema.Struct({
      entryId: TrimmedNonEmptyString,
      outcome: Schema.Literals(["passed", "failed"]),
      excerpt: Schema.optional(
        Schema.String.annotate({ description: "The relevant lines of the output, as printed." }),
      ),
      url: Schema.optional(Schema.String),
      commit: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({
      outcome: Schema.String,
      returned: Schema.Boolean.annotate({ description: "The task went back to its thread." }),
      escalated: Schema.Boolean.annotate({
        description: "The corrections ran out; the user was asked in the Inbox instead.",
      }),
      attempts: Schema.Int,
    }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Report a check's result"),
  false,
);

const TaskReturnTool = writing(
  Tool.make("task_return", {
    description:
      "Send a task that did not pass back to the thread that did it, alone: with the finding and the exact scope of the correction (only this, nothing beside it). Each return counts an attempt; after 3 corrections the task is not sent back again but raised to the user as a question, since the fault then likely lies in the plan.",
    parameters: Schema.Struct({
      entryId: TrimmedNonEmptyString,
      finding: TrimmedNonEmptyString.annotate({ description: "What is wrong, with the evidence." }),
      scope: TrimmedNonEmptyString.annotate({
        description: "What exactly to change, and what to leave alone.",
      }),
      threadId: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description: "The thread that did the task, when the task names none yet.",
        }),
      ),
    }),
    success: Schema.Struct({ status: Schema.String, attempts: Schema.Int }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Return a task for correction"),
  false,
);

const RollbackMarkTool = writing(
  Tool.make("rollback_mark", {
    description:
      "Mark finished work of your initiative as rolled back (reverted, undone), or take that back: a task by entryId, or an approved request by observationId. Rollbacks count against the thread that did the work and weigh in the preflight's evidence.",
    parameters: Schema.Struct({
      entryId: Schema.optional(TrimmedNonEmptyString),
      observationId: Schema.optional(TrimmedNonEmptyString),
      rolledBack: Schema.Boolean,
    }),
    success: Schema.Struct({ rolledBack: Schema.Boolean }),
    failure: InitiativeToolError,
    dependencies,
  }).annotate(Tool.Title, "Mark work as rolled back"),
  true,
);

export const InitiativesToolkit = Toolkit.make(
  CheckDefineTool,
  CheckReportTool,
  TaskReturnTool,
  RollbackMarkTool,
  StatsEstimateTool,
  QuestionAskTool,
  EntryCreateTool,
  EntryListTool,
  DecisionRecordTool,
  DecisionReopenTool,
  EntrySupersedeTool,
  EntryLinkTool,
  EntryStatusTool,
  BrainReadTool,
  BrainSearchTool,
  BrainWriteTool,
  HandoffUpdateTool,
  BrainTidyTool,
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
