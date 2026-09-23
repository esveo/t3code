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
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

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
    return `Thread ${this.threadId} is not one of the threads you started. Call list_threads for their ids.`;
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
        "An attachment already in this thread or one you started: its attachmentId, or the ref of its t3-context link (file_…). read_thread lists a thread's attachments.",
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
        "Project to start the thread in, by id or workspace path from list_projects. Defaults to your project. In another project the worktree starts from that repository's current commit, and worktree: false means its main checkout.",
    }),
  ),
  provider: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Provider instance id to run the thread on (for example claudeAgent or codex). Defaults to yours.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Model id for the thread. Defaults to yours." }),
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
  threadId: TrimmedNonEmptyString.annotate({ description: "Id of a thread you started." }),
};

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
  ...ThreadTarget,
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
  .annotate(Tool.OpenWorld, false);

const SendToThreadTool = Tool.make("send_to_thread", {
  description:
    "Send a message to one of the threads you started: more instructions, a correction, an answer, or a request to continue, optionally with files attached. It is delivered at once, also while the thread is working.",
  parameters: SendToThreadInput,
  success: Schema.Struct({ delivered: Schema.Boolean }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ProjectSummary = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  current: Schema.Boolean.annotate({ description: "True for the project this thread is in." }),
});
export type ProjectSummary = typeof ProjectSummary.Type;

const ListProjectsTool = Tool.make("list_projects", {
  description:
    "List the projects of this T3 Code environment, to start a thread in another repository with start_thread's project.",
  success: Schema.Struct({ projects: Schema.Array(ProjectSummary) }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadsTool = Tool.make("list_threads", {
  description: `List the threads you started with their state, what they are doing, todo progress, branch and pull requests. ${LINKING}`,
  success: Schema.Struct({ threads: Schema.Array(ChildThreadSummary) }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read one of your threads: its state, its latest answers and the files attached to its messages, for example to review a result before you combine it with others.",
  parameters: ReadThreadInput,
  success: ReadThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

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
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(
  ListProjectsTool,
  CreateThreadTool,
  SendToThreadTool,
  ListThreadsTool,
  ReadThreadTool,
  StopThreadTool,
);
