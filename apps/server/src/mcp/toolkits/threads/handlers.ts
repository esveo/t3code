import {
  type ChatAttachment,
  CommandId,
  type ThreadDecision,
  MessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  childThreadProgress,
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

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadDecisions from "../../../threadDecisions/ThreadDecisions.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { describeMessageAttachments, makeThreadAttachments } from "./attachments.ts";
import { suggestBranches } from "./branchSuggestions.ts";
import {
  ChildThreadNotFoundError,
  type ChildThreadSummary,
  type DecisionSummary,
  ThreadOrchestrationDisabledError,
  ThreadOrchestrationFailedError,
  ThreadOrchestrationNestedError,
  type ThreadAttachmentInput,
  ThreadNotFoundError,
  ThreadsToolkit,
} from "./tools.ts";

/** A thread's latest answers can be long; the coordinator gets a readable excerpt. */
const ANSWER_MAX_LENGTH = 12_000;

export function threadLink(thread: Pick<OrchestrationThreadShell, "id" | "title">): string {
  return `[${thread.title.replaceAll("]", ")")}](${threadLinkHref(thread.id)})`;
}

/** Most threads list_threads returns with scope "all"; a search should not flood the context. */
const LIST_ALL_MAX_THREADS = 50;

/** What the tools report about a thread; exported so the shape is testable without a layer. */
export function summarizeChildThread(
  thread: OrchestrationThreadShell,
  coordinatorId: ThreadId,
): ChildThreadSummary {
  return {
    threadId: thread.id,
    title: thread.title,
    link: threadLink(thread),
    state: resolveChildThreadState(thread),
    detail: describeChildThread(thread),
    progress: childThreadProgress(thread),
    branch: thread.branch,
    projectId: thread.projectId,
    worktreePath: thread.worktreePath,
    pullRequests: thread.pullRequests.map((link) => link.url),
    updatedAt: thread.updatedAt,
    settledAt: thread.settledAt,
    child: thread.parentThreadId === coordinatorId,
  };
}

/**
 * Why a coordinator may not settle this thread yet, or null when nothing is
 * open. Stricter than the settle the user has in the sidebar: a question for
 * the user or a plan still waits on them, so the coordinator leaves it.
 */
export function settleBlocker(
  thread: Pick<
    OrchestrationThreadShell,
    | "session"
    | "latestTurn"
    | "backgroundLiveness"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
  >,
): string | null {
  if (thread.hasPendingApprovals) return "It waits on an approval from the user.";
  if (thread.hasPendingUserInput) return "It has a question for the user.";
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return "It is still working.";
  }
  if (thread.backgroundLiveness != null) {
    return "Its background tasks (subagents, commands, monitors) still run.";
  }
  if (thread.hasActionableProposedPlan) return "Its plan waits on the user to implement it.";
  return null;
}

/**
 * The threads list_threads reports: the coordinator's own by default, or with
 * scope "all" every other thread, newest first and capped. Archived threads
 * only on request; deleted ones never reach the shell snapshot.
 */
export function selectListedThreads(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  input: {
    readonly coordinatorId: ThreadId;
    readonly scope: "children" | "all";
    readonly title?: string | undefined;
    readonly projectId?: string | undefined;
    readonly includeArchived?: boolean | undefined;
    readonly settled?: boolean | undefined;
  },
): { readonly threads: ReadonlyArray<OrchestrationThreadShell>; readonly omitted: number } {
  const title = input.title?.toLowerCase();
  const matches = threads.filter(
    (thread) =>
      thread.id !== input.coordinatorId &&
      (input.scope === "all" || thread.parentThreadId === input.coordinatorId) &&
      (input.includeArchived === true || thread.archivedAt === null) &&
      (input.settled === undefined || (thread.settledAt !== null) === input.settled) &&
      (title === undefined || thread.title.toLowerCase().includes(title)) &&
      (input.projectId === undefined || thread.projectId === input.projectId),
  );
  if (input.scope === "children") return { threads: matches, omitted: 0 };
  const newestFirst = matches.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    threads: newestFirst.slice(0, LIST_ALL_MAX_THREADS),
    omitted: Math.max(0, newestFirst.length - LIST_ALL_MAX_THREADS),
  };
}

/** A decision as list_decisions reports it: the answer in words, not ids. */
export function summarizeDecision(decision: ThreadDecision): DecisionSummary {
  const option = decision.options.find((candidate) => candidate.id === decision.answer?.optionId);
  const answer = decision.answer
    ? [option?.label, decision.answer.text].filter((part) => part).join(" – ") || null
    : null;
  return {
    id: decision.id,
    title: decision.title,
    status: decision.status,
    urgency: decision.urgency,
    answer,
    resolvedReason: decision.resolvedReason,
    snoozed: decision.snoozedAt !== null,
    askedBack: decision.askedBackAt !== null,
  };
}

function clampAnswer(text: string): string {
  return text.length > ANSWER_MAX_LENGTH
    ? `${text.slice(0, ANSWER_MAX_LENGTH)}\n… (${text.length - ANSWER_MAX_LENGTH} more characters)`
    : text;
}

const failure = (detail: string) => new ThreadOrchestrationFailedError({ detail });

/** Keeps interrupts as interrupts; everything else becomes a readable tool failure. */
const failWith =
  (detail: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, ThreadOrchestrationFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(
          failure(
            `${detail}: ${Cause.squash(cause) instanceof Error ? (Cause.squash(cause) as Error).message : "unknown error"}`,
          ),
        );

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const threadAttachments = yield* makeThreadAttachments;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:thread-orchestration-${tag}:${id}`));
  const dispatch = (
    command: Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[0],
    detail: string,
  ) => engine.dispatch(command).pipe(Effect.catchCause(failWith(detail)));

  /** The calling thread, when orchestration is on and the thread may coordinate. */
  const requireCoordinator = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("threads");
    const enabled = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.enableThreadOrchestration),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return yield* new ThreadOrchestrationDisabledError({});
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.catchCause(failWith("Could not read this thread")));
    if (Option.isNone(thread)) {
      return yield* failure(`Thread ${scope.threadId} was not found.`);
    }
    if (thread.value.parentThreadId) return yield* new ThreadOrchestrationNestedError({});
    return thread.value;
  });

  const requireChild = Effect.fn("ThreadsToolkit.requireChild")(function* (
    coordinator: OrchestrationThreadShell,
    threadId: string,
  ) {
    const child = yield* snapshots
      .getThreadShellById(ThreadId.make(threadId))
      .pipe(Effect.catchCause(failWith("Could not read the thread")));
    if (Option.isNone(child) || child.value.parentThreadId !== coordinator.id) {
      return yield* new ChildThreadNotFoundError({ threadId });
    }
    return child.value;
  });

  /**
   * Resolves the files a coordinator attaches, before anything is created.
   * An id is looked up in the thread it names, so any thread `read_thread`
   * shows works, then in the coordinator's own thread and the threads it started.
   */
  const resolveAttachments = Effect.fn("ThreadsToolkit.resolveAttachments")(function* (
    coordinator: OrchestrationThreadShell,
    attachments: ReadonlyArray<ThreadAttachmentInput> | undefined,
  ) {
    if (!attachments || attachments.length === 0) return [];
    const children = attachments.some((entry) => entry.attachmentId !== undefined)
      ? yield* snapshots.getShellSnapshot().pipe(
          Effect.map((snapshot) =>
            snapshot.threads
              .filter((thread) => thread.parentThreadId === coordinator.id)
              .map((thread) => thread.id),
          ),
          Effect.catchCause(failWith("Could not list the threads")),
        )
      : [];
    return yield* threadAttachments.resolve({
      attachments,
      threadsToSearch: [coordinator.id, ...children],
      readMessages: (threadId) =>
        snapshots.getThreadDetailById(threadId).pipe(
          Effect.map((detail) => (Option.isSome(detail) ? detail.value.messages : [])),
          Effect.catchCause(failWith("Could not read the thread")),
        ),
    });
  });

  /** A base ref that does not resolve, with the branches the coordinator probably meant. */
  const unknownBaseRef = Effect.fn("ThreadsToolkit.unknownBaseRef")(function* (
    cwd: string,
    baseRef: string,
  ) {
    const refs: Array<VcsListRefsResult["refs"][number]> = [];
    let cursor: number | null = 0;
    while (cursor !== null && refs.length < 5_000) {
      const page: VcsListRefsResult = yield* gitWorkflow.listRefs({
        cwd,
        refKind: "all",
        includeMatchingRemoteRefs: true,
        cursor,
        limit: 200,
      });
      refs.push(...page.refs);
      cursor = page.nextCursor;
    }
    return suggestBranches(baseRef, refs);
  });

  /** The coordinator's project, or another one named by id or workspace path. */
  const resolveTargetProject = Effect.fn("ThreadsToolkit.resolveTargetProject")(function* (
    coordinator: OrchestrationThreadShell,
    target: string | undefined,
  ) {
    const projects = yield* snapshots
      .getProjectShells()
      .pipe(Effect.catchCause(failWith("Could not read the projects")));
    const wanted = target?.trim().replace(/\/+$/, "");
    const project = wanted
      ? projects.find(
          (candidate) =>
            candidate.id === wanted || candidate.workspaceRoot.replace(/\/+$/, "") === wanted,
        )
      : projects.find((candidate) => candidate.id === coordinator.projectId);
    if (!project) {
      return yield* failure(
        wanted
          ? `No project matches ${wanted}. Call list_projects for their ids.`
          : "This thread's project was not found.",
      );
    }
    return project;
  });

  const startTurn = Effect.fn("ThreadsToolkit.startTurn")(function* (input: {
    readonly thread: Pick<
      OrchestrationThreadShell,
      "id" | "modelSelection" | "runtimeMode" | "interactionMode"
    >;
    readonly messageId: MessageId;
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* dispatch(
      {
        type: "thread.turn.start",
        commandId: yield* commandId("turn-start"),
        threadId: input.thread.id,
        message: {
          messageId: input.messageId,
          role: "user",
          text: input.text,
          attachments: input.attachments,
        },
        modelSelection: input.thread.modelSelection,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: yield* nowIso,
      },
      "Could not start the thread's turn",
    );
  });

  /**
   * Checks out the worktree, records it on the thread, runs the project's
   * setup script and then starts the first turn, as a new thread from the
   * composer does. It runs after start_thread has returned: a checkout can
   * take a while and the coordinator should not wait for it. A failure marks
   * the thread's session as failed, which reaches the coordinator as an update.
   */
  const prepareWorktreeAndStart = Effect.fn("ThreadsToolkit.prepareWorktreeAndStart")(
    function* (input: {
      readonly child: Pick<
        OrchestrationThreadShell,
        "id" | "projectId" | "modelSelection" | "runtimeMode" | "interactionMode"
      >;
      readonly repositoryCwd: string;
      readonly projectCwd: string;
      readonly baseRef: string;
      readonly baseBranch: string | null;
      readonly branch: string;
      readonly messageId: MessageId;
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }) {
      const worktree = yield* gitWorkflow
        .createWorktree({
          cwd: input.repositoryCwd,
          refName: input.baseRef,
          newRefName: input.branch,
          ...(input.baseBranch ? { baseRefName: input.baseBranch } : {}),
          path: null,
        })
        .pipe(Effect.catchCause(failWith("Could not create the worktree")));
      yield* dispatch(
        {
          type: "thread.meta.update",
          commandId: yield* commandId("meta-update"),
          threadId: input.child.id,
          branch: worktree.worktree.refName,
          worktreePath: worktree.worktree.path,
        },
        "Could not record the worktree",
      );
      const setup = yield* setupScripts
        .runForThread({
          threadId: input.child.id,
          projectId: input.child.projectId,
          projectCwd: input.projectCwd,
          worktreePath: worktree.worktree.path,
          observeCompletion: {},
        })
        .pipe(Effect.option);
      // A blocking setup script (dependencies, env files) finishes before the agent starts.
      if (
        Option.isSome(setup) &&
        setup.value.status === "started" &&
        !setup.value.async &&
        setup.value.completion
      ) {
        yield* setup.value.completion;
      }
      yield* startTurn({
        thread: input.child,
        messageId: input.messageId,
        text: input.text,
        attachments: input.attachments,
      });
    },
  );

  const markFailed = (
    child: Pick<OrchestrationThreadShell, "id" | "runtimeMode" | "modelSelection">,
    lastError: string,
  ) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: yield* commandId("session-failed"),
        threadId: child.id,
        session: {
          threadId: child.id,
          status: "error",
          providerName: null,
          providerInstanceId: child.modelSelection.instanceId,
          runtimeMode: child.runtimeMode,
          activeTurnId: null,
          lastError,
          updatedAt: at,
        },
        createdAt: at,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  return ThreadsToolkit.of({
    start_thread: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const project = yield* resolveTargetProject(coordinator, input.project);
        const sameProject = project.id === coordinator.projectId;
        const projectCwd = project.workspaceRoot;
        // In its own project a thread starts from the coordinator's checkout;
        // in another one there is no such checkout, so from that project's.
        const repositoryCwd = sameProject ? (coordinator.worktreePath ?? projectCwd) : projectCwd;
        const sharedBranch = sameProject ? coordinator.branch : null;
        const sharedWorktreePath = sameProject ? coordinator.worktreePath : null;
        const wantsWorktree = input.worktree !== false;
        const isRepository = wantsWorktree
          ? yield* gitWorkflow.isRepository(repositoryCwd).pipe(Effect.orElseSucceed(() => false))
          : false;
        if (wantsWorktree && !isRepository) {
          return yield* failure(
            "This project is not a git repository, so the thread cannot get its own worktree. Pass worktree: false to let it work in the project's checkout.",
          );
        }
        const baseRef = input.baseBranch ?? "HEAD";
        if (wantsWorktree) {
          const exists = yield* gitWorkflow
            .hasCommit({ cwd: repositoryCwd, refName: baseRef })
            .pipe(Effect.orElseSucceed(() => false));
          if (!exists) {
            const suggestions = yield* unknownBaseRef(repositoryCwd, baseRef).pipe(
              Effect.orElseSucceed((): string[] => []),
            );
            return yield* failure(
              `${baseRef} is not a commit in this repository.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`,
            );
          }
        }
        const attachmentSources = yield* resolveAttachments(coordinator, input.attachments);

        const modelSelection: ModelSelection =
          input.provider || input.model
            ? {
                instanceId: input.provider
                  ? ProviderInstanceId.make(input.provider)
                  : coordinator.modelSelection.instanceId,
                model: input.model ?? coordinator.modelSelection.model,
              }
            : coordinator.modelSelection;
        const threadId = ThreadId.make(yield* uuid);
        const messageId = MessageId.make(yield* uuid);
        const attachments = yield* threadAttachments.claim(threadId, attachmentSources);
        const text = wrapFromCoordinator({
          coordinatorThreadId: coordinator.id,
          coordinatorTitle: coordinator.title,
          text: input.prompt,
        });
        const child = {
          id: threadId,
          projectId: project.id,
          modelSelection,
          runtimeMode: coordinator.runtimeMode,
          interactionMode: "default" as const,
        };
        const createdAt = yield* nowIso;
        yield* dispatch(
          {
            type: "thread.create",
            commandId: yield* commandId("thread-create"),
            threadId,
            projectId: project.id,
            parentThreadId: coordinator.id,
            title: input.title,
            modelSelection,
            runtimeMode: child.runtimeMode,
            interactionMode: child.interactionMode,
            branch: wantsWorktree ? null : sharedBranch,
            worktreePath: wantsWorktree ? null : sharedWorktreePath,
            createdAt,
          },
          "Could not create the thread",
        );

        if (!wantsWorktree) {
          yield* startTurn({ thread: child, messageId, text, attachments });
          return {
            threadId,
            link: threadLink({ id: threadId, title: input.title }),
            branch: sharedBranch,
            worktree: false,
          };
        }

        // The task shows in the thread right away, and the thread reads as
        // working while its worktree is prepared; the turn start below
        // references this message instead of sending it again.
        yield* dispatch(
          {
            type: "thread.message.user.append",
            commandId: yield* commandId("message"),
            threadId,
            message: { messageId, text, attachments },
            createdAt,
          },
          "Could not record the task",
        );
        yield* dispatch(
          {
            type: "thread.session.set",
            commandId: yield* commandId("session-starting"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: null,
              providerInstanceId: modelSelection.instanceId,
              runtimeMode: child.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          },
          "Could not mark the thread as starting",
        );
        const randomHex = yield* crypto.randomBytes(4).pipe(
          Effect.map((bytes) =>
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
          Effect.orDie,
        );
        const branch = buildTemporaryWorktreeBranchName(() => randomHex);
        yield* prepareWorktreeAndStart({
          child,
          repositoryCwd,
          projectCwd,
          baseRef,
          baseBranch: input.baseBranch ?? sharedBranch,
          branch,
          messageId,
          text,
          attachments,
        }).pipe(
          Effect.catch((error) => markFailed(child, error.message)),
          Effect.forkDetach,
        );
        return {
          threadId,
          link: threadLink({ id: threadId, title: input.title }),
          branch,
          worktree: true,
        };
      }),

    send_to_thread: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const child = yield* requireChild(coordinator, input.threadId);
        const attachmentSources = yield* resolveAttachments(coordinator, input.attachments);
        const attachments = yield* threadAttachments.claim(child.id, attachmentSources);
        yield* startTurn({
          thread: child,
          messageId: MessageId.make(yield* uuid),
          text: wrapFromCoordinator({
            coordinatorThreadId: coordinator.id,
            coordinatorTitle: coordinator.title,
            text: input.message,
          }),
          attachments,
        }).pipe(Effect.tapError(() => threadAttachments.release(attachments)));
        return { delivered: true };
      }),

    list_projects: () =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const projects = yield* snapshots
          .getProjectShells()
          .pipe(Effect.catchCause(failWith("Could not list the projects")));
        return {
          projects: projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            current: project.id === coordinator.projectId,
          })),
        };
      }),

    list_threads: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const project = input.project
          ? yield* resolveTargetProject(coordinator, input.project)
          : null;
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.catchCause(failWith("Could not list the threads")));
        const listed = selectListedThreads(snapshot.threads, {
          coordinatorId: coordinator.id,
          scope: input.scope ?? "children",
          title: input.title,
          projectId: project?.id,
          includeArchived: input.includeArchived,
          settled: input.settled,
        });
        return {
          threads: listed.threads.map((thread) => summarizeChildThread(thread, coordinator.id)),
          omitted: listed.omitted,
        };
      }),

    // Reading reaches every thread of this environment, so a coordinator can
    // pick up earlier work; messaging and stopping stay with its own threads.
    read_thread: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const found = yield* snapshots
          .getThreadShellById(ThreadId.make(input.threadId))
          .pipe(Effect.catchCause(failWith("Could not read the thread")));
        if (Option.isNone(found)) {
          return yield* new ThreadNotFoundError({ threadId: input.threadId });
        }
        const child = found.value;
        const detail = yield* snapshots
          .getThreadDetailById(child.id)
          .pipe(Effect.catchCause(failWith("Could not read the thread")));
        const messages = Option.isSome(detail) ? detail.value.messages : [];
        const answers = messages
          .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
          .slice(-(input.messages ?? 1))
          .map((message) => clampAnswer(message.text));
        return {
          thread: summarizeChildThread(child, coordinator.id),
          latestAnswers: answers,
          attachments: describeMessageAttachments(messages, threadAttachments.attachmentsDir),
        };
      }),

    stop_thread: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const child = yield* requireChild(coordinator, input.threadId);
        if (resolveChildThreadState(child) !== "working") return { stopped: false };
        yield* dispatch(
          {
            type: "thread.turn.interrupt",
            commandId: yield* commandId("interrupt"),
            threadId: child.id,
            createdAt: yield* nowIso,
          },
          "Could not stop the thread",
        );
        return { stopped: true };
      }),

    // Same command as the sidebar's settle; each thread is settled on its own.
    settle_thread: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
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
          return yield* dispatch(
            { type: "thread.settle", commandId: yield* commandId("settle"), threadId: child.id },
            "Could not settle the thread",
          ).pipe(
            Effect.as({ threadId, outcome: "settled" as const, detail: "Settled." }),
            Effect.catchTag("ThreadOrchestrationFailedError", (error) =>
              Effect.succeed({ threadId, outcome: "blocked" as const, detail: error.detail }),
            ),
          );
        });
        const results = yield* Effect.forEach(input.threadIds, settleOne);
        return { results };
      }),

    upsert_decision: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const source = input.sourceThreadId
          ? yield* requireChild(coordinator, input.sourceThreadId)
          : null;
        const route = input.routeToThreadId
          ? yield* requireChild(coordinator, input.routeToThreadId)
          : null;
        const { decision, all } = yield* ThreadDecisions.withService((decisions) =>
          Effect.gen(function* () {
            const decision = yield* decisions.upsert(coordinator.id, {
              ...input,
              sourceThreadId: source?.id,
              routeToThreadId: route?.id,
            });
            return { decision, all: yield* decisions.list(coordinator.id) };
          }),
        ).pipe(Effect.mapError((error) => failure(error.message)));
        return {
          decisionId: decision.id,
          open: all.filter((candidate) => candidate.status === "open").length,
        };
      }),

    resolve_decision: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        yield* ThreadDecisions.withService((decisions) =>
          decisions.resolve(coordinator.id, input.id, input.reason),
        ).pipe(Effect.mapError((error) => failure(error.message)));
        return { resolved: true };
      }),

    list_decisions: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const status = input.status ?? "open";
        const all = yield* ThreadDecisions.withService((decisions) =>
          decisions.list(coordinator.id),
        ).pipe(Effect.mapError((error) => failure(error.message)));
        return {
          decisions: all
            .filter((decision) => status === "all" || decision.status === status)
            .map(summarizeDecision),
        };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
