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
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});
export type ChildThreadSummary = typeof ChildThreadSummary.Type;

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
        "Branch or commit the new worktree starts from. Defaults to your current commit.",
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

export const ReadThreadResult = Schema.Struct({
  thread: ChildThreadSummary,
  latestAnswers: Schema.Array(Schema.String),
});
export type ReadThreadResult = typeof ReadThreadResult.Type;

const CreateThreadTool = Tool.make("create_thread", {
  description: `Start a new thread that works on a task in parallel, as a child of this one. ${WHEN_TO_USE} It gets its own session, sidebar entry and (by default) git worktree and branch. You do not need to poll: when it finishes, fails or waits on the user, you receive a message about it. ${LINKING}`,
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
    "Send a message to one of the threads you started: more instructions, a correction, an answer, or a request to continue. It is delivered at once, also while the thread is working.",
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
    "Read one of your threads: its state and its latest answers, for example to review a result before you combine it with others.",
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
  CreateThreadTool,
  SendToThreadTool,
  ListThreadsTool,
  ReadThreadTool,
  StopThreadTool,
);
