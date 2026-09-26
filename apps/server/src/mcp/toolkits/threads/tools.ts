/**
 * Fork: thread orchestration. A coordinator thread starts child threads, each
 * a full T3 thread with its own session (and usually its own worktree), and
 * follows them from here. Children report back on their own: when one
 * finishes, fails or waits on the user, the coordinator gets a message.
 */
import {
  McpCapabilityUnavailableError,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { isOrchestrationToolOn } from "../../McpOrchestrationTools.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

// Offered in tools/list, and callable, only while the user has the switch on (Settings).
const whileThreadsOn = () => isOrchestrationToolOn("threads");
const whileDecisionsOn = () => isOrchestrationToolOn("decisions");

const WHEN_TO_USE =
  "Use a thread for a self-contained piece of work with its own result (a branch, a pull request, a document) that the user may want to watch, steer or review on its own; keep quick lookups and checks in subagents.";
const LINKING =
  "Mention a thread to the user as a Markdown link [title](t3-thread:THREAD_ID): the app renders it as a chip with the thread's live state.";

export class ThreadOrchestrationDisabledError extends Schema.TaggedError<ThreadOrchestrationDisabledError>()(
  "ThreadOrchestrationDisabledError",
  {},
) {
  override get message(): string {
    return "Thread orchestration is turned off. The user can turn it on in Settings.";
  }
}

export class ThreadOrchestrationNestedError extends Schema.TaggedError<ThreadOrchestrationNestedError>()(
  "ThreadOrchestrationNestedError",
  {},
) {
  override get message(): string {
    return "This thread was started by a coordinator and cannot start threads of its own. Use subagents instead.";
  }
}

export class ChildThreadNotFoundError extends Schema.TaggedError<ChildThreadNotFoundError>()(
  "ChildThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not one of your threads. read_thread can still read it; to message or stop it, ask the user to assign it to you (sidebar: right-click the thread, Assign to coordinator), or adopt it with adopt_thread when the user asked you to take it over. Call list_threads for your threads' ids.`;
  }
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found. Call list_threads with scope "all" to find a thread by title.`;
  }
}

export class ThreadOrchestrationFailedError extends Schema.TaggedError<ThreadOrchestrationFailedError>()(
  "ThreadOrchestrationFailedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ThreadsToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadOrchestrationDisabledError,
  ThreadOrchestrationNestedError,
  ChildThreadNotFoundError,
  ThreadNotFoundError,
  ThreadOrchestrationFailedError,
]);
export type ThreadsToolError = typeof ThreadsToolError.Type;

const ChildThreadState = Schema.Literals([
  "waiting",
  "failed",
  "working",
  "review",
  "stopped",
  "done",
]);

export const ChildThreadSummary = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  link: Schema.String.annotate({ description: "Markdown link to show the thread to the user." }),
  state: ChildThreadState.annotate({
    description:
      "waiting: blocked on the user (approval or question); working; failed; review: has an open pull request; stopped; done.",
  }),
  detail: Schema.String,
  progress: Schema.NullOr(Schema.Struct({ completed: Schema.Int, total: Schema.Int })),
  projectId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(Schema.String),
  updatedAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String).annotate({
    description:
      "When the thread was settled (marked as dealt with, out of the user's active list); null while it is active.",
  }),
  child: Schema.Boolean.annotate({
    description:
      "True for your own threads, which you can message and stop. Others you can only read.",
  }),
});
export type ChildThreadSummary = typeof ChildThreadSummary.Type;

export const ThreadAttachmentInput = Schema.Struct({
  path: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Absolute path of a local file on the machine T3 Code runs on.",
    }),
  ),
  attachmentId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "An attachment already in a thread: its attachmentId from read_thread, which works for any thread you can read, or the ref of a t3-context link (file_…) in this thread or one you started.",
    }),
  ),
  name: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "File name the thread sees. Defaults to the original name.",
    }),
  ),
});
export type ThreadAttachmentInput = typeof ThreadAttachmentInput.Type;

const attachmentsParameter = Schema.optional(
  Schema.Array(ThreadAttachmentInput).annotate({
    description:
      "Files to attach to the message, each by path or attachmentId. They arrive as if the user had attached them: images up to 10 MiB as images, anything else as files up to 50 MiB.",
  }),
);

export const CreateThreadInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({
    description: "Short name for the thread, as the user will see it in the sidebar.",
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The task. The thread starts without your context, so include what it needs: the goal, constraints, relevant files and how to report back.",
  }),
  worktree: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true (default): the thread works in a new git worktree on its own branch, created from your current commit, so threads never step on each other's changes. false: it works in your checkout; choose this only for read-only work or when it must see your uncommitted changes.",
    }),
  ),
  baseBranch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch or commit the new worktree starts from; origin/<branch> for a branch that only exists on the remote. Defaults to your current commit.",
    }),
  ),
  project: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Project to start the thread in, by id, workspace path or title from list_projects. Defaults to your project. In another project the worktree starts from that repository's current commit, and worktree: false means its main checkout.",
    }),
  ),
  provider: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Provider to run the thread on, one of list_projects' providers (for example claudeAgent or codex). Defaults to yours.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model for the thread, one of the provider's models from list_projects. Defaults to yours, or to the provider's default when you name another provider.",
    }),
  ),
  language: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The language the user writes to you in, for example German. The thread answers the user in it; without it, it answers in the language of your prompt.",
    }),
  ),
  attachments: attachmentsParameter,
});
export type CreateThreadInput = typeof CreateThreadInput.Type;

export const CreateThreadResult = Schema.Struct({
  threadId: Schema.String,
  link: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktree: Schema.Boolean,
});
export type CreateThreadResult = typeof CreateThreadResult.Type;

const ThreadTarget = {
  threadId: TrimmedNonEmptyString.annotate({ description: "Id of one of your threads." }),
};

export const ListThreadsInput = Schema.Struct({
  scope: Schema.optional(
    Schema.Literals(["children", "all"]).annotate({
      description:
        "children (default): your own threads. all: every thread of this environment, to find one you did not start, for example by title.",
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Only threads whose title contains this text, ignoring case.",
    }),
  ),
  project: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Only threads of this project, by id, workspace path or title from list_projects.",
    }),
  ),
  includeArchived: Schema.optional(
    Schema.Boolean.annotate({ description: "Also list archived threads. Defaults to false." }),
  ),
  settled: Schema.optional(
    Schema.Boolean.annotate({
      description: "true: only settled threads. false: only active ones. Defaults to both.",
    }),
  ),
});
export type ListThreadsInput = typeof ListThreadsInput.Type;

export const ListThreadsResult = Schema.Struct({
  threads: Schema.Array(ChildThreadSummary),
  omitted: Schema.Int.annotate({
    description:
      "Matching threads left out beyond the most recently updated ones; narrow the filter to see them.",
  }),
});
export type ListThreadsResult = typeof ListThreadsResult.Type;

export const SendToThreadInput = Schema.Struct({
  ...ThreadTarget,
  message: TrimmedNonEmptyString.annotate({
    description:
      "What to tell the thread. It arrives as a message from you; a finished thread resumes.",
  }),
  attachments: attachmentsParameter,
});
export type SendToThreadInput = typeof SendToThreadInput.Type;

export const ReadThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyString.annotate({
    description: "Id of any thread, yours or one found with list_threads scope all.",
  }),
  messages: Schema.optional(
    PositiveInt.annotate({
      description: "How many of its latest answers to return. Defaults to 1.",
    }),
  ),
});
export type ReadThreadInput = typeof ReadThreadInput.Type;

export const ThreadAttachmentSummary = Schema.Struct({
  messageId: Schema.String,
  role: Schema.String,
  attachmentId: Schema.String.annotate({
    description: "Pass it as attachmentId to start_thread or send_to_thread to hand the file on.",
  }),
  type: Schema.Literals(["image", "file"]),
  name: Schema.String.annotate({ description: "The original file name." }),
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  path: Schema.NullOr(Schema.String).annotate({ description: "Local path, to read the file." }),
});
export type ThreadAttachmentSummary = typeof ThreadAttachmentSummary.Type;

export const ReadThreadResult = Schema.Struct({
  thread: ChildThreadSummary,
  latestAnswers: Schema.Array(Schema.String),
  attachments: Schema.Array(ThreadAttachmentSummary).annotate({
    description: "Every file attached to the thread's messages, oldest first.",
  }),
});
export type ReadThreadResult = typeof ReadThreadResult.Type;

export const SettleThreadsInput = Schema.Struct({
  threadIds: Schema.NonEmptyArray(TrimmedNonEmptyString).annotate({
    description: "Ids of your threads to settle, one or more.",
  }),
});
export type SettleThreadsInput = typeof SettleThreadsInput.Type;

export const SettleThreadResult = Schema.Struct({
  threadId: Schema.String,
  outcome: Schema.Literals(["settled", "already_settled", "blocked", "not_yours"]).annotate({
    description:
      "settled; already_settled: nothing changed; blocked: it still has open work, see detail; not_yours: not one of your threads.",
  }),
  detail: Schema.String,
});
export type SettleThreadResult = typeof SettleThreadResult.Type;

const CreateThreadTool = Tool.make("start_thread", {
  description: `Start a new thread that works on a task in parallel, as a child of this one. ${WHEN_TO_USE} It gets its own session, sidebar entry and (by default) git worktree and branch, in your project or another one (see list_projects). Attach files the user gave you with attachments instead of pasting their paths. You do not need to poll: when it finishes, fails or waits on the user, you receive a message about it. ${LINKING}`,
  parameters: CreateThreadInput,
  success: CreateThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

const SendToThreadTool = Tool.make("send_to_thread", {
  description:
    "Send a message to one of your threads: more instructions, a correction, an answer, or a request to continue, optionally with files attached. It is delivered at once, also while the thread is working.",
  parameters: SendToThreadInput,
  success: Schema.Struct({ delivered: Schema.Boolean }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

export const ProjectSummary = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  current: Schema.Boolean.annotate({ description: "True for the project this thread is in." }),
});
export type ProjectSummary = typeof ProjectSummary.Type;

export const ProviderSummary = Schema.Struct({
  provider: Schema.String.annotate({ description: "Pass it as start_thread's provider." }),
  name: Schema.String,
  models: Schema.Array(Schema.String).annotate({
    description:
      "Model ids for start_thread's model. Empty when the provider decides its models at runtime; then any model id is passed on.",
  }),
  current: Schema.Boolean.annotate({ description: "True for the provider this thread runs on." }),
});
export type ProviderSummary = typeof ProviderSummary.Type;

const ListProjectsTool = Tool.make("list_projects", {
  description:
    "List the projects of this T3 Code environment and the providers with their models, to start a thread in another repository or on another model with start_thread. A folder that is not a project yet can be added with create_project.",
  success: Schema.Struct({
    projects: Schema.Array(ProjectSummary),
    providers: Schema.Array(ProviderSummary),
  }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

// Field names follow upstream's t3_project_create (Orchestration V2), which replaces this tool.
export const CreateProjectInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.annotate({
    description:
      "Absolute path of the project's folder (~ for the home folder) on the machine T3 Code runs on, which may not be the machine the user sits at.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Name shown in the sidebar. Defaults to the folder name.",
    }),
  ),
  createWorkspaceRootIfMissing: Schema.optional(
    Schema.Boolean.annotate({
      description: "true: create the folder when it does not exist yet. Defaults to false.",
    }),
  ),
});
export type CreateProjectInput = typeof CreateProjectInput.Type;

export const CreateProjectResult = Schema.Struct({
  project: ProjectSummary,
  created: Schema.Boolean.annotate({
    description: "false when the folder already was a project; that project is returned.",
  }),
});
export type CreateProjectResult = typeof CreateProjectResult.Type;

const CreateProjectTool = Tool.make("create_project", {
  description:
    "Add a folder as a project of this T3 Code environment, as the user can with Add project, so you can start threads in it with start_thread (pass its projectId as project). Only when the user asked for a new project or for work in a folder that is not one yet. Calling it for a folder that already is a project returns that project.",
  parameters: CreateProjectInput,
  success: CreateProjectResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create a project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

const ListThreadsTool = Tool.make("list_threads", {
  description: `List your threads (the ones you started or the user assigned to you) with their state, what they are doing, todo progress, branch and pull requests. With scope "all" it finds any thread of this environment, by title or project, to read it with read_thread. ${LINKING}`,
  parameters: ListThreadsInput,
  success: ListThreadsResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read a thread: its state, its latest answers and the files attached to its messages, for example to review a result before you combine it with others. Works on any thread of this environment; only your own can be messaged or stopped.",
  parameters: ReadThreadInput,
  success: ReadThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

const StopThreadTool = Tool.make("stop_thread", {
  description:
    "Stop the running turn of one of your threads, for example when its work is no longer needed. It can be resumed with send_to_thread.",
  parameters: Schema.Struct(ThreadTarget),
  success: Schema.Struct({ stopped: Schema.Boolean }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

const SettleThreadTool = Tool.make("settle_thread", {
  description:
    "Settle finished threads of yours: they leave the user's active list, as when the user settles them in the sidebar. Only a thread with nothing open settles: no running turn or background tasks, no approval, question or plan waiting on the user. Messaging a settled thread with send_to_thread makes it active again. Each thread gets its own result.",
  parameters: SettleThreadsInput,
  success: Schema.Struct({ results: Schema.Array(SettleThreadResult) }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Settle threads")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

export const AdoptThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyString.annotate({
    description: "Id of the thread, for example from list_threads with scope all.",
  }),
  detach: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true: release one of your threads instead, so it is no longer yours and stops reporting to you.",
    }),
  ),
});
export type AdoptThreadInput = typeof AdoptThreadInput.Type;

export const AdoptThreadResult = Schema.Struct({
  thread: ChildThreadSummary,
  previousParentThreadId: Schema.NullOr(Schema.String).annotate({
    description: "The coordinator it belonged to before, if any.",
  }),
});
export type AdoptThreadResult = typeof AdoptThreadResult.Type;

const AdoptThreadTool = Tool.make("adopt_thread", {
  description: `Make an existing thread one of yours, as the user can with Assign to coordinator in the sidebar: you can then message and stop it, and its updates reach you. Only do this when the user explicitly asks you to take a thread over; otherwise just read it with read_thread. With detach: true it releases one of your threads again. ${LINKING}`,
  parameters: AdoptThreadInput,
  success: AdoptThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Adopt a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileThreadsOn);

const DecisionOptionInput = Schema.Struct({
  id: TrimmedNonEmptyString.annotate({ description: "Short id, unique within the decision." }),
  label: TrimmedNonEmptyString.annotate({
    description: "The answer in a few words, as the user clicks it (for example: Volle Historie).",
  }),
  detail: Schema.optional(
    Schema.String.annotate({ description: "One short line under the label, if needed." }),
  ),
  pros: Schema.optional(Schema.Array(Schema.String)),
  cons: Schema.optional(Schema.Array(Schema.String)),
});

export const UpsertDecisionInput = Schema.Struct({
  id: TrimmedNonEmptyString.annotate({
    description:
      "Stable id you choose (for example stichtag). Calling upsert_decision again with it updates the decision; for one that was answered or resolved it asks again.",
  }),
  kind: Schema.optional(
    Schema.Literals(["decision", "task"]).annotate({
      description:
        "decision (default): the user picks an option. task: a step only the user can do (enter a deploy key, click through a console, create an account); it takes no options, the user checks it off with an optional note, and you get Done back. Keeps the kind it has when left out.",
    }),
  ),
  title: TrimmedNonEmptyString.annotate({
    description: "A few words naming what is to decide; the row the user sees in the Inbox.",
  }),
  question: TrimmedNonEmptyString.annotate({
    description:
      "The question itself in one or two sentences, in the user's language; for a task, what to do.",
  }),
  context: Schema.optional(
    Schema.String.annotate({
      description:
        "Markdown the user needs to decide and nothing more: facts, risks, numbers, a draft to approve.",
    }),
  ),
  options: Schema.optional(
    Schema.Array(DecisionOptionInput).annotate({
      description:
        "The answers to choose from, required for a decision; for a yes/no question both. The user can always answer in their own words instead. Leave out for a task.",
    }),
  ),
  recommended: Schema.optional(
    Schema.Struct({
      optionId: TrimmedNonEmptyString,
      reason: Schema.optional(Schema.String.annotate({ description: "Why, in one sentence." })),
    }),
  ),
  urgency: Schema.optional(
    Schema.Literals(["now", "today", "later"]).annotate({
      description: "now: blocks work; today (default); later: can wait.",
    }),
  ),
  sourceThreadId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Your thread the question comes from, when it is not your own. Ignored in a thread a coordinator started: that thread is the source.",
    }),
  ),
  routeToThreadId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Your thread the answer is for. The answer still reaches you; pass it on with send_to_thread. Ignored in a thread a coordinator started: the answer is for that thread.",
    }),
  ),
  dependsOn: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description: "Ids of decisions this one depends on; the Inbox asks those first.",
    }),
  ),
});
export type UpsertDecisionInput = typeof UpsertDecisionInput.Type;

export const DecisionSummary = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["decision", "task"]),
  title: Schema.String,
  status: Schema.Literals(["open", "answered", "resolved"]),
  urgency: Schema.Literals(["now", "today", "later"]),
  answer: Schema.NullOr(Schema.String),
  resolvedReason: Schema.NullOr(Schema.String),
  snoozed: Schema.Boolean.annotate({
    description: "The user put it aside until your next change.",
  }),
  askedBack: Schema.Boolean.annotate({
    description: "The user asked for pros and cons or an explanation instead of answering.",
  }),
  sourceThreadId: Schema.NullOr(Schema.String).annotate({
    description:
      "The thread the question comes from; one of your threads may have asked it itself.",
  }),
});
export type DecisionSummary = typeof DecisionSummary.Type;

const DECISIONS_USE =
  "Use decisions whenever you need the user to decide or approve something, instead of numbering questions in a chat message: they stay visible in the user's Inbox until answered, however many updates arrive in between.";
const TASKS_USE =
  'When the user has to do something by hand rather than choose (enter a deploy key, approve in a console), pass kind "task" instead of dressing it up as a decision with a single option.';
const CHILD_DECISIONS =
  "In a thread a coordinator started, the item goes to the coordinator's Inbox with this thread as its source; the answer reaches the coordinator, which passes it on to you, and you see only your own items.";

const UpsertDecisionTool = Tool.make("upsert_decision", {
  description: `Ask the user for a decision, or update one you asked before. ${DECISIONS_USE} ${TASKS_USE} It shows in the Inbox tab of the coordinator with its options, your recommendation and context. The user's answers arrive as one message tagged t3_decisions; answers for one of your threads name it, so pass them on. Mention in chat only briefly that something waits in the Inbox. ${CHILD_DECISIONS}`,
  parameters: UpsertDecisionInput,
  success: Schema.Struct({
    decisionId: Schema.String,
    open: Schema.Int.annotate({ description: "Your decisions still open after this one." }),
  }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask for a decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileDecisionsOn);

const ResolveDecisionTool = Tool.make("resolve_decision", {
  description:
    "Withdraw an open decision or task that no longer needs the user, for example because another result settled it. It leaves the Inbox with your reason.",
  parameters: Schema.Struct({
    id: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString.annotate({
      description: "Why it is settled, in one sentence the user reads.",
    }),
  }),
  success: Schema.Struct({ resolved: Schema.Boolean }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Withdraw a decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileDecisionsOn);

const ListDecisionsTool = Tool.make("list_decisions", {
  description:
    "List your decisions and tasks and what the user answered, instead of repeating open questions in chat.",
  parameters: Schema.Struct({
    status: Schema.optional(
      Schema.Literals(["open", "answered", "resolved", "all"]).annotate({
        description: "Defaults to open.",
      }),
    ),
  }),
  success: Schema.Struct({ decisions: Schema.Array(DecisionSummary) }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List decisions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, whileDecisionsOn);

export const ThreadsToolkit = Toolkit.make(
  ListProjectsTool,
  CreateProjectTool,
  CreateThreadTool,
  SendToThreadTool,
  ListThreadsTool,
  ReadThreadTool,
  StopThreadTool,
  SettleThreadTool,
  AdoptThreadTool,
  UpsertDecisionTool,
  ResolveDecisionTool,
  ListDecisionsTool,
);
