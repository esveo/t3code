/**
 * Fork: starting a thread the way a coordinator's start_thread does, for
 * every caller that starts one on the server: the threads toolkit and the
 * initiatives module. The caller chooses the thread's id, parent and runtime
 * mode; this checks the checkout, creates the thread, records the task and
 * prepares its worktree before the first turn.
 */
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import { suggestBranches } from "./branchSuggestions.ts";
import { ThreadOrchestrationFailedError } from "./tools.ts";

export const failure = (detail: string) => new ThreadOrchestrationFailedError({ detail });

/** Keeps interrupts as interrupts; everything else becomes a readable tool failure. */
export const failWith =
  (detail: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, ThreadOrchestrationFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(
          failure(
            `${detail}: ${Cause.squash(cause) instanceof Error ? (Cause.squash(cause) as Error).message : "unknown error"}`,
          ),
        );

/** Where a new thread works, checked before anything is created. */
export interface ThreadCheckout {
  readonly project: Pick<OrchestrationProjectShell, "id" | "workspaceRoot">;
  readonly repositoryCwd: string;
  readonly wantsWorktree: boolean;
  readonly baseRef: string;
  readonly baseBranch: string | null;
  /** Branch and worktree a thread without a worktree of its own shares. */
  readonly sharedBranch: string | null;
  readonly sharedWorktreePath: string | null;
}

export interface ThreadStartInput {
  readonly checkout: ThreadCheckout;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly title: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export const makeThreadStarter = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:thread-orchestration-${tag}:${id}`));
  const dispatch = (
    command: Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[0],
    detail: string,
  ) => engine.dispatch(command).pipe(Effect.catchCause(failWith(detail)));

  /** A base ref that does not resolve, with the branches the caller probably meant. */
  const unknownBaseRef = Effect.fn("ThreadStarter.unknownBaseRef")(function* (
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

  /**
   * Where the thread will work. In its parent's project it starts from the
   * parent's checkout; in another one, or without a parent, from the
   * project's own checkout.
   */
  const checkout = Effect.fn("ThreadStarter.checkout")(function* (input: {
    readonly parent: Pick<OrchestrationThreadShell, "projectId" | "branch" | "worktreePath"> | null;
    readonly project: Pick<OrchestrationProjectShell, "id" | "workspaceRoot">;
    readonly worktree: boolean;
    readonly baseBranch: string | undefined;
  }) {
    const { parent, project } = input;
    const sameProject = parent !== null && project.id === parent.projectId;
    const repositoryCwd = sameProject
      ? (parent.worktreePath ?? project.workspaceRoot)
      : project.workspaceRoot;
    const sharedBranch = sameProject ? parent.branch : null;
    const sharedWorktreePath = sameProject ? parent.worktreePath : null;
    const isRepository = input.worktree
      ? yield* gitWorkflow.isRepository(repositoryCwd).pipe(Effect.orElseSucceed(() => false))
      : false;
    if (input.worktree && !isRepository) {
      return yield* failure(
        "This project is not a git repository, so the thread cannot get its own worktree. Pass worktree: false to let it work in the project's checkout.",
      );
    }
    const baseRef = input.baseBranch ?? "HEAD";
    if (input.worktree) {
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
    return {
      project,
      repositoryCwd,
      wantsWorktree: input.worktree,
      baseRef,
      baseBranch: input.baseBranch ?? sharedBranch,
      sharedBranch,
      sharedWorktreePath,
    } satisfies ThreadCheckout;
  });

  const startTurn = Effect.fn("ThreadStarter.startTurn")(function* (input: {
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
   * composer does. It runs after the start has returned: a checkout can take
   * a while and the caller should not wait for it. A failure marks the
   * thread's session as failed, which reaches a coordinator as an update.
   */
  const prepareWorktreeAndStart = Effect.fn("ThreadStarter.prepareWorktreeAndStart")(
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

  /**
   * Creates the thread under the caller's id and starts its task. The
   * decider refuses an id that exists, so a repeated start fails instead of
   * creating a second thread.
   */
  const start = Effect.fn("ThreadStarter.start")(function* (input: ThreadStartInput) {
    const { checkout: plan, threadId } = input;
    const messageId = MessageId.make(yield* uuid);
    const child = {
      id: threadId,
      projectId: plan.project.id,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default" as const,
    };
    const createdAt = yield* nowIso;
    yield* dispatch(
      {
        type: "thread.create",
        commandId: yield* commandId("thread-create"),
        threadId,
        projectId: plan.project.id,
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: child.runtimeMode,
        interactionMode: child.interactionMode,
        branch: plan.wantsWorktree ? null : plan.sharedBranch,
        worktreePath: plan.wantsWorktree ? null : plan.sharedWorktreePath,
        createdAt,
      },
      "Could not create the thread",
    );

    if (!plan.wantsWorktree) {
      yield* startTurn({
        thread: child,
        messageId,
        text: input.text,
        attachments: input.attachments,
      });
      return { threadId, branch: plan.sharedBranch, worktree: false };
    }

    // The task shows in the thread right away, and the thread reads as
    // working while its worktree is prepared; the turn start below
    // references this message instead of sending it again.
    yield* dispatch(
      {
        type: "thread.message.user.append",
        commandId: yield* commandId("message"),
        threadId,
        message: { messageId, text: input.text, attachments: input.attachments },
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
          providerInstanceId: input.modelSelection.instanceId,
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
      repositoryCwd: plan.repositoryCwd,
      projectCwd: plan.project.workspaceRoot,
      baseRef: plan.baseRef,
      baseBranch: plan.baseBranch,
      branch,
      messageId,
      text: input.text,
      attachments: input.attachments,
    }).pipe(
      Effect.catch((error) => markFailed(child, error.message)),
      Effect.forkDetach,
    );
    return { threadId, branch, worktree: true };
  });

  return { checkout, start, startTurn };
});

export type ThreadStarter = Effect.Success<typeof makeThreadStarter>;
