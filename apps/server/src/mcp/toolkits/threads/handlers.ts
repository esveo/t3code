/**
 * Fork: the coordinator's thread tools on Orchestrator V2. A child thread is a
 * V2 delegated task (start_thread calls delegate_task), a thread the user put
 * under the coordinator, or both; ThreadCoordinators says which threads a
 * coordinator has. Reading reaches every thread of the environment, across
 * projects, so a coordinator can pick up earlier work; messaging, stopping and
 * settling stay with its own threads.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadCoordinatorsError,
  type ThreadDecision,
  ThreadDecisionsError,
  ThreadId,
} from "@t3tools/contracts";
import {
  coordinatorThreadIdOf,
  describeChildThread,
  resolveChildThreadState,
  threadLinkHref,
  wrapFromCoordinator,
} from "@t3tools/shared/threadOrchestration";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { expandHomePathWith } from "../../../pathExpansion.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadDecisions from "../../../threadDecisions/ThreadDecisions.ts";
import { ThreadCoordinators } from "../../../threadOrchestration/ThreadCoordinators.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";
import { describeMessageAttachments, makeThreadAttachments } from "./attachments.ts";
import { childTaskText } from "./childTask.ts";
import { matchProject } from "./projectMatch.ts";
import {
  ChildThreadNotFoundError,
  type ChildThreadSummary,
  type DecisionSummary,
  type ThreadAttachmentInput,
  ThreadNotFoundError,
  ThreadOrchestrationDisabledError,
  ThreadOrchestrationFailedError,
  ThreadOrchestrationNestedError,
  ThreadsToolkit,
} from "./tools.ts";

/** A thread's latest answers can be long; the coordinator gets a readable excerpt. */
const ANSWER_MAX_LENGTH = 12_000;

/** Most threads list_threads returns with scope "all"; a search should not flood the context. */
const LIST_ALL_MAX_THREADS = 50;

type Shell = OrchestrationV2ThreadShell;

export function threadLink(thread: Pick<Shell, "id" | "title">): string {
  return `[${thread.title.replaceAll("]", ")")}](${threadLinkHref(thread.id)})`;
}

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

/** What the tools report about a thread; exported so the shape is testable without a layer. */
export function summarizeChildThread(thread: Shell, isChild: boolean): ChildThreadSummary {
  return {
    threadId: thread.id,
    title: thread.title,
    link: threadLink(thread),
    state: resolveChildThreadState(thread),
    detail: describeChildThread(thread),
    branch: thread.branch,
    projectId: thread.projectId,
    worktreePath: thread.worktreePath,
    pullRequests: (thread.pullRequests ?? []).map((link) => link.url),
    updatedAt: iso(thread.updatedAt),
    settledAt: thread.settledAt === null ? null : iso(thread.settledAt),
    child: isChild,
  };
}

/**
 * Why a coordinator may not settle this thread yet, or null when nothing is
 * open. Stricter than the settle the user has in the sidebar: a question for
 * the user or a plan still waits on them, so the coordinator leaves it.
 */
export function settleBlocker(
  thread: Pick<
    Shell,
    | "status"
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "pendingBackgroundTasks"
    | "hasActionableProposedPlan"
    | "lastError"
    | "pullRequests"
  >,
): string | null {
  if (thread.pendingRuntimeRequest !== null) {
    return thread.pendingRuntimeRequest.kind === "user_input"
      ? "It has a question for the user."
      : "It waits on an approval from the user.";
  }
  if ((thread.pendingBackgroundTasks?.length ?? 0) > 0) {
    return "Its background tasks (subagents, commands, monitors) still run.";
  }
  if (resolveChildThreadState(thread) === "working") return "It is still working.";
  if (thread.hasActionableProposedPlan) return "Its plan waits on the user to implement it.";
  return null;
}

/**
 * The threads list_threads reports: the coordinator's own by default, or with
 * scope "all" every other thread, newest first and capped.
 */
export function selectListedThreads(
  threads: ReadonlyArray<Shell>,
  input: {
    readonly coordinatorId: ThreadId;
    readonly isChild: (thread: Shell) => boolean;
    readonly scope: "children" | "all";
    readonly title?: string | undefined;
    readonly projectId?: string | undefined;
    readonly includeArchived?: boolean | undefined;
    readonly settled?: boolean | undefined;
  },
): { readonly threads: ReadonlyArray<Shell>; readonly omitted: number } {
  const title = input.title?.toLowerCase();
  const matches = threads.filter(
    (thread) =>
      thread.id !== input.coordinatorId &&
      thread.deletedAt === null &&
      (input.scope === "all" || input.isChild(thread)) &&
      (input.includeArchived === true || thread.archivedAt === null) &&
      (input.settled === undefined || (thread.settledAt !== null) === input.settled) &&
      (title === undefined || thread.title.toLowerCase().includes(title)) &&
      (input.projectId === undefined || thread.projectId === input.projectId),
  );
  if (input.scope === "children") return { threads: matches, omitted: 0 };
  const newestFirst = matches.toSorted(
    (a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
  );
  return {
    threads: newestFirst.slice(0, LIST_ALL_MAX_THREADS),
    omitted: Math.max(0, newestFirst.length - LIST_ALL_MAX_THREADS),
  };
}

/** A decision as list_decisions reports it: the answer in words, not ids. */
export function summarizeDecision(decision: ThreadDecision): DecisionSummary {
  const option = decision.options.find((candidate) => candidate.id === decision.answer?.optionId);
  const answer = decision.answer
    ? [option?.label, decision.answer.text].filter((part) => part).join(" – ") ||
      (decision.kind === "task" ? "Done" : null)
    : null;
  return {
    id: decision.id,
    kind: decision.kind,
    title: decision.title,
    status: decision.status,
    urgency: decision.urgency,
    answer,
    resolvedReason: decision.resolvedReason,
    snoozed: decision.snoozedAt !== null,
    askedBack: decision.askedBackAt !== null,
    sourceThreadId: decision.sourceThreadId,
  };
}

function clampAnswer(text: string): string {
  return text.length > ANSWER_MAX_LENGTH
    ? `${text.slice(0, ANSWER_MAX_LENGTH)}\n… (${text.length - ANSWER_MAX_LENGTH} more characters)`
    : text;
}

const failure = (detail: string) => new ThreadOrchestrationFailedError({ detail });

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "unknown error";
}

/** Keeps interrupts as interrupts; everything else becomes a readable tool failure. */
const failWith =
  (detail: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, ThreadOrchestrationFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(failure(`${detail}: ${messageOf(Cause.squash(cause))}`));

const noCoordinators = () =>
  new ThreadCoordinatorsError({ message: "This server does not keep coordinator links." });
const unavailableCoordinators: ThreadCoordinators["Service"] = {
  overrides: Effect.fail(noCoordinators()),
  coordinatorOf: () => Effect.fail(noCoordinators()),
  childrenOf: () => Effect.fail(noCoordinators()),
  set: () => Effect.fail(noCoordinators()),
  subscribe: Stream.fail(noCoordinators()),
  lastReportedRun: () => Effect.fail(noCoordinators()),
  markReported: () => Effect.fail(noCoordinators()),
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  // Read optionally, so layers that mount every toolkit need not provide it.
  const coordinatorsOption = yield* Effect.serviceOption(ThreadCoordinators);
  const coordinators: ThreadCoordinators["Service"] = Option.isSome(coordinatorsOption)
    ? coordinatorsOption.value
    : unavailableCoordinators;
  const orchestrator = yield* OrchestratorMcpService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const threadAttachments = yield* makeThreadAttachments;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:thread-orchestration-${tag}:${id}`));

  // Both switches are read live, not from the session's credential, so a
  // change in Settings reaches running sessions (see McpOrchestrationTools).
  const readSwitches = serverSettings.getSettings.pipe(
    Effect.map((settings) => ({
      threads: settings.enableThreadOrchestration,
      decisions: settings.enableThreadDecisions,
    })),
    Effect.orElseSucceed(() => ({ threads: false, decisions: false })),
  );

  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.catchCause(failWith("Could not read the thread")),
      Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
    );

  const coordinatorOf = (thread: Shell) =>
    coordinators
      .coordinatorOf(thread)
      .pipe(Effect.catchCause(failWith("Could not read the thread")));

  /** The calling thread, when orchestration is on and the thread may coordinate. */
  const requireCoordinator = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!(yield* readSwitches).threads) return yield* new ThreadOrchestrationDisabledError({});
    const thread = yield* readShell(scope.threadId);
    if (thread === null) return yield* failure(`Thread ${scope.threadId} was not found.`);
    if ((yield* coordinatorOf(thread)) !== null) {
      return yield* new ThreadOrchestrationNestedError({});
    }
    return { scope, coordinator: thread };
  });

  /**
   * Whose Inbox the calling thread writes to, when the user also turned on
   * decisions (Settings): a coordinator its own; a child its coordinator's,
   * as `child`, limited to the items it asked.
   */
  const requireDecisions = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const switches = yield* readSwitches;
    if (!switches.threads) return yield* new ThreadOrchestrationDisabledError({});
    if (!switches.decisions) {
      return yield* failure(
        "Decisions are turned off, so ask the user in chat instead. The user can turn them on in Settings.",
      );
    }
    const thread = yield* readShell(scope.threadId);
    if (thread === null) return yield* failure(`Thread ${scope.threadId} was not found.`);
    const coordinatorId = yield* coordinatorOf(thread);
    if (coordinatorId === null) return { coordinator: thread, child: null };
    const coordinator = yield* readShell(coordinatorId);
    if (coordinator === null) {
      return yield* failure(
        "The coordinator of this thread is gone, so ask the user in your final answer instead.",
      );
    }
    return { coordinator, child: thread };
  });

  /** The items a child sees of its coordinator's Inbox: the ones it asked. */
  const ownDecisions = (all: ReadonlyArray<ThreadDecision>, child: Shell | null) =>
    child ? all.filter((decision) => decision.sourceThreadId === child.id) : all;

  const requireChild = Effect.fn("ThreadsToolkit.requireChild")(function* (
    coordinator: Shell,
    threadId: string,
  ) {
    const child = yield* readShell(ThreadId.make(threadId));
    if (child === null || (yield* coordinatorOf(child)) !== coordinator.id) {
      return yield* new ChildThreadNotFoundError({ threadId });
    }
    return child;
  });

  const readMessages = (threadId: ThreadId) =>
    Effect.gen(function* () {
      // Threads carried over from V1 load their transcript on first read.
      yield* threads.ensureLegacyTranscript(threadId).pipe(Effect.ignore);
      const records = yield* threads.getThreadRecords(threadId, ["messages"]);
      return records.messages;
    }).pipe(Effect.catchCause(failWith("Could not read the thread")));

  /**
   * Resolves the files a coordinator attaches, before anything is created.
   * An id is looked up in the thread it names, so any thread `read_thread`
   * shows works, then in the coordinator's own thread and its children.
   */
  const resolveAttachments = Effect.fn("ThreadsToolkit.resolveAttachments")(function* (
    coordinator: Shell,
    attachments: ReadonlyArray<ThreadAttachmentInput> | undefined,
  ) {
    if (!attachments || attachments.length === 0) return [];
    const children = attachments.some((entry) => entry.attachmentId !== undefined)
      ? (yield* coordinators
          .childrenOf(coordinator.id)
          .pipe(Effect.catchCause(failWith("Could not list the threads")))).map(
          (thread) => thread.id,
        )
      : [];
    return yield* threadAttachments.resolve({
      attachments,
      threadsToSearch: [coordinator.id, ...children],
      readMessages,
    });
  });

  const listProjects = projects
    .listShells()
    .pipe(Effect.catchCause(failWith("Could not read the projects")));

  const resolveProject = Effect.fn("ThreadsToolkit.resolveProject")(function* (target: string) {
    const matched = matchProject(yield* listProjects, target);
    if ("error" in matched) return yield* failure(matched.error);
    return matched.project;
  });

  const orchestratorFailure = <A, R>(
    effect: Effect.Effect<A, { readonly message: string }, R>,
  ): Effect.Effect<A, ThreadOrchestrationFailedError, R> =>
    effect.pipe(Effect.mapError((error) => failure(error.message)));

  return ThreadsToolkit.of({
    start_thread: (input) =>
      Effect.gen(function* () {
        const { scope, coordinator } = yield* requireCoordinator;
        const wantsWorktree = input.worktree !== false;
        const attachmentSources = yield* resolveAttachments(coordinator, input.attachments);
        // Filed under the coordinator: the child's id exists only once the task does.
        const attachments = yield* threadAttachments.claim(coordinator.id, attachmentSources);
        const task = wrapFromCoordinator({
          coordinatorThreadId: coordinator.id,
          coordinatorTitle: coordinator.title,
          text: childTaskText({ prompt: input.prompt, language: input.language }),
        });
        const result = yield* orchestratorFailure(
          orchestrator.delegateTask(
            scope,
            {
              task,
              title: input.title,
              mode: "async",
              ...(input.provider || input.model
                ? {
                    target: {
                      ...(input.provider ? { providerInstanceId: input.provider as never } : {}),
                      ...(input.model ? { model: input.model } : {}),
                    },
                  }
                : {}),
              workspace: {
                ...(input.project ? { project: input.project } : {}),
                worktree: wantsWorktree,
                ...(input.baseBranch ? { baseRef: input.baseBranch } : {}),
              },
            },
            { attachments },
          ),
        ).pipe(Effect.tapError(() => threadAttachments.release(attachments)));
        const child = yield* readShell(result.childThreadId);
        return {
          threadId: result.childThreadId,
          taskId: result.taskId,
          link: threadLink({ id: result.childThreadId, title: input.title }),
          branch: wantsWorktree ? null : (child?.branch ?? null),
          worktree: wantsWorktree,
        };
      }),

    send_to_thread: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        const child = yield* requireChild(coordinator, input.threadId);
        const attachmentSources = yield* resolveAttachments(coordinator, input.attachments);
        const attachments = yield* threadAttachments.claim(child.id, attachmentSources);
        yield* threads
          .sendToThread({
            projectId: child.projectId,
            commandId: yield* commandId("send"),
            threadId: child.id,
            messageId: MessageId.make(yield* uuid),
            senderThreadId: coordinator.id,
            text: wrapFromCoordinator({
              coordinatorThreadId: coordinator.id,
              coordinatorTitle: coordinator.title,
              text: input.message,
            }),
            attachments,
            mode: "auto",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.catchCause(failWith("Could not send the message")),
            Effect.tapError(() => threadAttachments.release(attachments)),
          );
        return { delivered: true };
      }),

    // The providers come from the same live catalog delegate_task checks against.
    list_projects: () =>
      Effect.gen(function* () {
        const { scope, coordinator } = yield* requireCoordinator;
        const capabilities = yield* orchestratorFailure(orchestrator.capabilities(scope));
        return {
          projects: (yield* listProjects).map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            current: project.id === coordinator.projectId,
          })),
          providers: capabilities.providers
            .filter((provider) => provider.canRunChildTask)
            .map((provider) => ({
              provider: provider.providerInstanceId,
              name: provider.displayName ?? provider.driverKind,
              models: provider.models.map((model) => model.id),
              current: provider.providerInstanceId === capabilities.inheritedProviderInstanceId,
            })),
        };
      }),

    // Upstream's t3_project_create does the work; an existing project is returned, not refused.
    create_project: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        // The server's working directory means nothing to the agent, so a relative path is refused.
        if (!path.isAbsolute(expandHomePathWith(input.workspaceRoot, path))) {
          return yield* failure(
            `${input.workspaceRoot} is not an absolute path. Pass the folder's full path.`,
          );
        }
        const summary = (project: { id: ProjectId; title: string; workspaceRoot: string }) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          current: project.id === coordinator.projectId,
        });
        const id = yield* commandId("project");
        const created = yield* projects
          .create({
            commandId: id,
            projectId: ProjectId.make(id),
            workspaceRoot: expandHomePathWith(input.workspaceRoot, path),
            title: input.title ?? (path.basename(input.workspaceRoot) || "project"),
            ...(input.createWorkspaceRootIfMissing === undefined
              ? {}
              : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
          })
          .pipe(
            Effect.map((project) => ({ project: summary(project), created: true })),
            Effect.catchTag("ProjectConflictError", (conflict) =>
              projects
                .getById(conflict.conflictingProjectId)
                .pipe(
                  Effect.flatMap((existing) =>
                    Option.isSome(existing)
                      ? Effect.succeed({ project: summary(existing.value), created: false })
                      : Effect.fail(conflict),
                  ),
                ),
            ),
            Effect.catchCause(failWith("Could not create the project")),
          );
        return created;
      }),

    list_threads: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        const project = input.project ? yield* resolveProject(input.project) : null;
        const links = yield* coordinators.overrides.pipe(
          Effect.catchCause(failWith("Could not list the threads")),
        );
        const active = yield* threads
          .getShellSnapshot()
          .pipe(Effect.catchCause(failWith("Could not list the threads")));
        const archived = input.includeArchived
          ? (yield* threads
              .getShellSnapshot({ location: "archive" })
              .pipe(Effect.catchCause(failWith("Could not list the threads")))).archivedThreads
          : [];
        const isChild = (thread: Shell) => coordinatorThreadIdOf(thread, links) === coordinator.id;
        const listed = selectListedThreads([...active.threads, ...archived], {
          coordinatorId: coordinator.id,
          isChild,
          scope: input.scope ?? "children",
          title: input.title,
          projectId: project?.id,
          includeArchived: input.includeArchived,
          settled: input.settled,
        });
        return {
          threads: listed.threads.map((thread) => summarizeChildThread(thread, isChild(thread))),
          omitted: listed.omitted,
        };
      }),

    read_thread: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        const found = yield* readShell(ThreadId.make(input.threadId));
        if (found === null) return yield* new ThreadNotFoundError({ threadId: input.threadId });
        const messages = yield* readMessages(found.id);
        const answers = messages
          .filter(
            (message: OrchestrationV2ConversationMessage) =>
              message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
          )
          .slice(-(input.messages ?? 1))
          .map((message) => clampAnswer(message.text));
        return {
          thread: summarizeChildThread(found, (yield* coordinatorOf(found)) === coordinator.id),
          latestAnswers: answers,
          attachments: describeMessageAttachments(messages, threadAttachments.attachmentsDir),
        };
      }),

    stop_thread: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        const child = yield* requireChild(coordinator, input.threadId);
        if (resolveChildThreadState(child) !== "working") return { stopped: false };
        const result = yield* threads
          .interruptThread({
            projectId: child.projectId,
            commandId: yield* commandId("interrupt"),
            threadId: child.id,
            reason: "Stopped by its coordinator.",
          })
          .pipe(Effect.catchCause(failWith("Could not stop the thread")));
        return { stopped: result.type === "interrupt_requested" };
      }),

    // Same command as the sidebar's settle; each thread is settled on its own.
    settle_thread: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        const settleOne = Effect.fn("ThreadsToolkit.settleOne")(function* (threadId: string) {
          const found = yield* requireChild(coordinator, threadId).pipe(
            Effect.map(Option.some),
            Effect.catchTag("ChildThreadNotFoundError", () => Effect.succeedNone),
          );
          if (Option.isNone(found)) {
            return {
              threadId,
              outcome: "not_yours" as const,
              detail: new ChildThreadNotFoundError({ threadId }).message,
            };
          }
          const child = found.value;
          if (child.archivedAt !== null) {
            return { threadId, outcome: "blocked" as const, detail: "It is archived." };
          }
          if (child.settledAt !== null) {
            return {
              threadId,
              outcome: "already_settled" as const,
              detail: "It was settled already.",
            };
          }
          const blocker = settleBlocker(child);
          if (blocker !== null) return { threadId, outcome: "blocked" as const, detail: blocker };
          return yield* threads
            .dispatch({
              type: "thread.settle",
              commandId: yield* commandId("settle"),
              threadId: child.id,
            })
            .pipe(
              Effect.as({ threadId, outcome: "settled" as const, detail: "Settled." }),
              Effect.catch((error) =>
                Effect.succeed({ threadId, outcome: "blocked" as const, detail: messageOf(error) }),
              ),
            );
        });
        const results = yield* Effect.forEach(input.threadIds, settleOne);
        return { results };
      }),

    // Same link as the sidebar's Assign to coordinator; ThreadCoordinators
    // checks the rules again (one level deep, no cycles).
    adopt_thread: (input) =>
      Effect.gen(function* () {
        const { coordinator } = yield* requireCoordinator;
        const threadId = ThreadId.make(input.threadId);
        if (threadId === coordinator.id) return yield* failure("A thread cannot adopt itself.");
        const thread = input.detach
          ? yield* requireChild(coordinator, input.threadId)
          : yield* readShell(threadId).pipe(
              Effect.flatMap((found) =>
                found !== null
                  ? Effect.succeed(found)
                  : Effect.fail(new ThreadNotFoundError({ threadId: input.threadId })),
              ),
            );
        const { previousCoordinatorThreadId } = yield* coordinators
          .set({ threadId: thread.id, coordinatorThreadId: input.detach ? null : coordinator.id })
          .pipe(Effect.mapError((error) => failure(error.message)));
        return {
          thread: summarizeChildThread(thread, !input.detach),
          previousParentThreadId: previousCoordinatorThreadId,
        };
      }),

    upsert_decision: (input) =>
      Effect.gen(function* () {
        const { coordinator, child } = yield* requireDecisions;
        // A child asks for itself: the item shows it as the source, and the
        // answer reaches the coordinator with the note to pass it on.
        const source = child
          ? child
          : input.sourceThreadId
            ? yield* requireChild(coordinator, input.sourceThreadId)
            : null;
        const route = child
          ? child
          : input.routeToThreadId
            ? yield* requireChild(coordinator, input.routeToThreadId)
            : null;
        const { decision, all } = yield* ThreadDecisions.withService((decisions) =>
          Effect.gen(function* () {
            if (child) {
              const taken = (yield* decisions.list(coordinator.id)).find(
                (candidate) => candidate.id === input.id && candidate.sourceThreadId !== child.id,
              );
              if (taken) {
                return yield* Effect.fail(
                  new ThreadDecisionsError({
                    message: `The id ${input.id} is already used in your coordinator's Inbox; choose another one.`,
                  }),
                );
              }
            }
            const decision = yield* decisions.upsert(coordinator.id, {
              ...input,
              sourceThreadId: source?.id,
              routeToThreadId: route?.id,
            });
            return { decision, all: ownDecisions(yield* decisions.list(coordinator.id), child) };
          }),
        ).pipe(Effect.mapError((error) => failure(error.message)));
        return {
          decisionId: decision.id,
          open: all.filter((candidate) => candidate.status === "open").length,
        };
      }),

    resolve_decision: (input) =>
      Effect.gen(function* () {
        const { coordinator, child } = yield* requireDecisions;
        yield* ThreadDecisions.withService((decisions) =>
          Effect.gen(function* () {
            if (child) {
              const own = ownDecisions(yield* decisions.list(coordinator.id), child);
              if (!own.some((decision) => decision.id === input.id)) {
                return yield* Effect.fail(
                  new ThreadDecisionsError({
                    message: `No decision ${input.id} of yours. Call list_decisions for the ids of yours.`,
                  }),
                );
              }
            }
            return yield* decisions.resolve(coordinator.id, input.id, input.reason);
          }),
        ).pipe(Effect.mapError((error) => failure(error.message)));
        return { resolved: true };
      }),

    list_decisions: (input) =>
      Effect.gen(function* () {
        const { coordinator, child } = yield* requireDecisions;
        const status = input.status ?? "open";
        const all = yield* ThreadDecisions.withService((decisions) =>
          decisions.list(coordinator.id),
        ).pipe(Effect.mapError((error) => failure(error.message)));
        return {
          decisions: ownDecisions(all, child)
            .filter((decision) => status === "all" || decision.status === status)
            .map(summarizeDecision),
        };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
