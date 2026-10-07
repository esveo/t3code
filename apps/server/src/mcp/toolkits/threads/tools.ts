/**
 * Fork: the coordinator tools upstream's orchestrator toolkit lacks. A
 * coordinator starts and follows its threads with upstream's tools
 * (delegate_task, t3_thread_*); adopt_thread puts an existing thread under
 * it, and the decisions tools (opt-in, Settings) keep the questions it has
 * for the user in its Inbox.
 */
import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { areDecisionToolsOn } from "../../McpOrchestrationTools.ts";

// McpToolAccess checks the caller with ThreadManagementService and refuses with OrchestratorMcpFailure.
const dependencies = [McpInvocationContext.McpInvocationContext, ThreadManagementService];

// Offered in tools/list, and callable, only while the user has decisions on (Settings).
const whileDecisionsOn = () => areDecisionToolsOn();

const LINKING =
  "Mention a thread to the user as a Markdown link [title](t3-thread:THREAD_ID): the app renders it as a chip with the thread's live state.";

export class ThreadOrchestrationNestedError extends Schema.TaggedError<ThreadOrchestrationNestedError>()(
  "ThreadOrchestrationNestedError",
  {},
) {
  override get message(): string {
    return "This thread was started by a coordinator and cannot coordinate threads of its own. Use subagents instead.";
  }
}

export class ChildThreadNotFoundError extends Schema.TaggedError<ChildThreadNotFoundError>()(
  "ChildThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not one of your threads (the ones you delegated with delegate_task or the user assigned to you). Adopt it with adopt_thread only when the user asked you to take it over.`;
  }
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found. Find a thread's id with t3_thread_list or t3_thread_search (scope 'all' reaches other projects when the user turned on Cross-project threads).`;
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
  OrchestratorMcpFailure,
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
    description: "True while the thread is yours, so its results reach you as updates.",
  }),
});
export type ChildThreadSummary = typeof ChildThreadSummary.Type;

export const AdoptThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyString.annotate({
    description: "Id of the thread, for example from t3_thread_list or t3_thread_search.",
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
  description: `Make an existing thread one of yours, as the user can with Assign to coordinator in the sidebar: it shows under this thread, and its results reach you as updates, like those of the threads you started with delegate_task. Threads of other projects only when the user turned on Cross-project threads. Only do this when the user explicitly asks you to take a thread over; otherwise just read it with t3_thread_read. With detach: true it releases one of your threads again. ${LINKING}`,
  parameters: AdoptThreadInput,
  success: AdoptThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Adopt a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

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
        "Your thread the answer is for. The answer still reaches you; pass it on with t3_thread_send. Ignored in a thread a coordinator started: the answer is for that thread.",
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
  AdoptThreadTool,
  UpsertDecisionTool,
  ResolveDecisionTool,
  ListDecisionsTool,
);
