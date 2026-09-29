/**
 * Fork: adopt_thread and the decisions tools on Orchestrator V2. A
 * coordinator's threads are its V2 delegated tasks, the threads the user put
 * under it, or both; ThreadCoordinators says which threads a coordinator has.
 */
import {
  type OrchestrationV2ThreadShell,
  ThreadCoordinatorsError,
  type ThreadDecision,
  ThreadDecisionsError,
  ThreadId,
} from "@t3tools/contracts";
import {
  describeChildThread,
  resolveChildThreadState,
  threadLinkHref,
} from "@t3tools/shared/threadOrchestration";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadDecisions from "../../../threadDecisions/ThreadDecisions.ts";
import { ThreadCoordinators } from "../../../threadOrchestration/ThreadCoordinators.ts";
import { CROSS_PROJECT_THREADS_HINT } from "../../forkThreadReach.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ChildThreadNotFoundError,
  type ChildThreadSummary,
  type DecisionSummary,
  ThreadNotFoundError,
  ThreadOrchestrationFailedError,
  ThreadOrchestrationNestedError,
  ThreadsToolkit,
} from "./tools.ts";

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
  reportsBaselined: Effect.fail(noCoordinators()),
  markReportsBaselined: Effect.fail(noCoordinators()),
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  // Read optionally, so layers that mount every toolkit need not provide it.
  const coordinatorsOption = yield* Effect.serviceOption(ThreadCoordinators);
  const coordinators: ThreadCoordinators["Service"] = Option.isSome(coordinatorsOption)
    ? coordinatorsOption.value
    : unavailableCoordinators;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  // Read live, not from the session's credential, so a change in Settings
  // reaches running sessions (see McpOrchestrationTools).
  const decisionsOn = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableThreadDecisions),
    Effect.orElseSucceed(() => false),
  );
  const crossProjectOn = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableCrossProjectThreads),
    Effect.orElseSucceed(() => false),
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

  /** The calling thread, when it may coordinate. */
  const requireCoordinator = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* readShell(scope.threadId);
    if (thread === null) return yield* failure(`Thread ${scope.threadId} was not found.`);
    if ((yield* coordinatorOf(thread)) !== null) {
      return yield* new ThreadOrchestrationNestedError({});
    }
    return { coordinator: thread };
  });

  /**
   * Whose Inbox the calling thread writes to, when the user also turned on
   * decisions (Settings): a coordinator its own; a child its coordinator's,
   * as `child`, limited to the items it asked.
   */
  const requireDecisions = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!(yield* decisionsOn)) {
      return yield* failure(
        "Decisions are turned off, so ask the user in chat instead. The user can turn them on in Settings → General.",
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

  return ThreadsToolkit.of({
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
        if (
          !input.detach &&
          thread.projectId !== coordinator.projectId &&
          !(yield* crossProjectOn)
        ) {
          return yield* failure(
            `'${thread.title}' is in another project. ${CROSS_PROJECT_THREADS_HINT}`,
          );
        }
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
