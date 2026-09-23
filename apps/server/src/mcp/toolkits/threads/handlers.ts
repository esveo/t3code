import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadShell,
  ProviderInstanceId,
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
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ChildThreadNotFoundError,
  type ChildThreadSummary,
  ThreadOrchestrationDisabledError,
  ThreadOrchestrationFailedError,
  ThreadOrchestrationNestedError,
  ThreadsToolkit,
} from "./tools.ts";

/** A thread's latest answers can be long; the coordinator gets a readable excerpt. */
const ANSWER_MAX_LENGTH = 12_000;

export function threadLink(thread: Pick<OrchestrationThreadShell, "id" | "title">): string {
  return `[${thread.title.replaceAll("]", ")")}](${threadLinkHref(thread.id)})`;
}

/** What the tools report about a child; exported so the shape is testable without a layer. */
export function summarizeChildThread(thread: OrchestrationThreadShell): ChildThreadSummary {
  return {
    threadId: thread.id,
    title: thread.title,
    link: threadLink(thread),
    state: resolveChildThreadState(thread),
    detail: describeChildThread(thread),
    progress: childThreadProgress(thread),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: thread.pullRequests.map((link) => link.url),
    updatedAt: thread.updatedAt,
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

  const startTurn = Effect.fn("ThreadsToolkit.startTurn")(function* (input: {
    readonly thread: Pick<
      OrchestrationThreadShell,
      "id" | "modelSelection" | "runtimeMode" | "interactionMode"
    >;
    readonly messageId: MessageId;
    readonly text: string;
  }) {
    yield* dispatch(
      {
        type: "thread.turn.start",
        commandId: yield* commandId("turn-start"),
        threadId: input.thread.id,
        message: { messageId: input.messageId, role: "user", text: input.text, attachments: [] },
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
      yield* startTurn({ thread: input.child, messageId: input.messageId, text: input.text });
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
        const project = yield* snapshots
          .getProjectShellById(coordinator.projectId)
          .pipe(Effect.catchCause(failWith("Could not read the project")));
        if (Option.isNone(project)) return yield* failure("This thread's project was not found.");
        const projectCwd = project.value.workspaceRoot;
        const repositoryCwd = coordinator.worktreePath ?? projectCwd;
        const wantsWorktree = input.worktree !== false;
        const isRepository = wantsWorktree
          ? yield* gitWorkflow.isRepository(repositoryCwd).pipe(Effect.orElseSucceed(() => false))
          : false;
        if (wantsWorktree && !isRepository) {
          return yield* failure(
            "This project is not a git repository, so the thread cannot get its own worktree. Pass worktree: false to let it work in your checkout.",
          );
        }
        const baseRef = input.baseBranch ?? "HEAD";
        if (wantsWorktree) {
          const exists = yield* gitWorkflow
            .hasCommit({ cwd: repositoryCwd, refName: baseRef })
            .pipe(Effect.orElseSucceed(() => false));
          if (!exists) return yield* failure(`${baseRef} is not a commit in this repository.`);
        }

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
        const text = wrapFromCoordinator({
          coordinatorThreadId: coordinator.id,
          coordinatorTitle: coordinator.title,
          text: input.prompt,
        });
        const child = {
          id: threadId,
          projectId: coordinator.projectId,
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
            projectId: coordinator.projectId,
            parentThreadId: coordinator.id,
            title: input.title,
            modelSelection,
            runtimeMode: child.runtimeMode,
            interactionMode: child.interactionMode,
            branch: wantsWorktree ? null : coordinator.branch,
            worktreePath: wantsWorktree ? null : coordinator.worktreePath,
            createdAt,
          },
          "Could not create the thread",
        );

        if (!wantsWorktree) {
          yield* startTurn({ thread: child, messageId, text });
          return {
            threadId,
            link: threadLink({ id: threadId, title: input.title }),
            branch: coordinator.branch,
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
            message: { messageId, text, attachments: [] },
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
          baseBranch: input.baseBranch ?? coordinator.branch,
          branch,
          messageId,
          text,
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
        yield* startTurn({
          thread: child,
          messageId: MessageId.make(yield* uuid),
          text: wrapFromCoordinator({
            coordinatorThreadId: coordinator.id,
            coordinatorTitle: coordinator.title,
            text: input.message,
          }),
        });
        return { delivered: true };
      }),

    list_threads: () =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.catchCause(failWith("Could not list the threads")));
        return {
          threads: snapshot.threads
            .filter(
              (thread) => thread.parentThreadId === coordinator.id && thread.archivedAt === null,
            )
            .map(summarizeChildThread),
        };
      }),

    read_thread: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator;
        const child = yield* requireChild(coordinator, input.threadId);
        const detail = yield* snapshots
          .getThreadDetailById(child.id)
          .pipe(Effect.catchCause(failWith("Could not read the thread")));
        const answers = Option.isSome(detail)
          ? detail.value.messages
              .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
              .slice(-(input.messages ?? 1))
              .map((message) => clampAnswer(message.text))
          : [];
        return { thread: summarizeChildThread(child), latestAnswers: answers };
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
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
