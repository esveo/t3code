/**
 * Fork: thread orchestration. Tells a coordinator about the results of its
 * threads that V2's delegated-task mailbox does not deliver.
 *
 * V2 wakes the thread that started a delegated child exactly once, with the
 * child's first result (Orchestrator.finalizeAppOwnedSubagent). A coordinator
 * keeps its threads for longer: it sends them follow-ups, the user puts
 * existing threads under it or moves them between coordinators, and a wake
 * V2 disposed (its parent run was interrupted) still has to arrive. Each of
 * those results reaches the coordinator here, as a queued message of
 * `<t3_thread_update>` blocks with the child's full answer, the same shape
 * V2's wakes carry in the fork (delegatedCompletionText.ts). Results that
 * arrive while such a message still waits in the coordinator's queue join it.
 *
 * A child's result is its latest run once V2 reports it `result_available`
 * (no run, subagent or background task of it still going). Which result each
 * child last reported is kept in `fork_thread_reports`, so nothing reaches a
 * coordinator twice, also across restarts.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  describeChildThread,
  parseThreadUpdates,
  resolveChildThreadState,
  wrapThreadUpdate,
} from "@t3tools/shared/threadOrchestration";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  delegatedTaskProgress,
  subagentResultForRun,
} from "../orchestration-v2/SubagentProjection.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ThreadCoordinators } from "./ThreadCoordinators.ts";

export type CoordinatorUpdateDecision =
  /** Nothing to send; `accounted` is recorded as reported so it stays quiet. */
  | { readonly kind: "skip"; readonly accounted: RunId | null }
  /** V2 has not published this result to the parent yet and will deliver it. */
  | { readonly kind: "wait" }
  | { readonly kind: "send"; readonly runId: RunId };

/**
 * Whether the coordinator should hear about the child's latest result now.
 * `lineageTask` is the coordinator's V2 task for the child when the
 * coordinator also started it; `resultTransferRunIds` the child runs V2
 * already published to it.
 */
export function decideCoordinatorUpdate(input: {
  readonly child: Pick<OrchestrationV2ThreadShell, "settledAt">;
  readonly coordinator: Pick<OrchestrationV2ThreadShell, "archivedAt" | "deletedAt"> | null;
  readonly resultRunId: RunId | null;
  readonly lastReportedRunId: RunId | null;
  readonly lineageTask: Pick<OrchestrationV2Subagent, "completionDelivery"> | undefined;
  readonly resultTransferRunIds: ReadonlyArray<RunId>;
}): CoordinatorUpdateDecision {
  const runId = input.resultRunId;
  if (runId === null || runId === input.lastReportedRunId) {
    return { kind: "skip", accounted: null };
  }
  if (
    input.coordinator === null ||
    input.coordinator.archivedAt !== null ||
    input.coordinator.deletedAt !== null ||
    // Settling says the result has been dealt with; new work unsettles first.
    input.child.settledAt !== null
  ) {
    return { kind: "skip", accounted: runId };
  }
  if (
    input.lineageTask !== undefined &&
    input.lineageTask.completionDelivery?.state !== "disposed"
  ) {
    if (input.resultTransferRunIds.includes(runId)) return { kind: "skip", accounted: runId };
    if (input.resultTransferRunIds.length === 0) return { kind: "wait" };
  }
  return { kind: "send", runId };
}

/** The update block the coordinator reads about one child result. */
export function childUpdateBlock(input: {
  readonly child: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "title"
    | "status"
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "lastError"
    | "pullRequests"
    | "pendingBackgroundTasks"
  >;
  readonly answer: string;
}): string {
  return wrapThreadUpdate({
    threadId: input.child.id,
    title: input.child.title,
    state: resolveChildThreadState(input.child),
    detail: describeChildThread(input.child),
    text: input.answer.trim() || "(It gave no answer.)",
  });
}

export class CoordinatorUpdates extends Context.Service<
  CoordinatorUpdates,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Reports the child's latest result to its coordinator when it has not heard of it. */
    readonly report: (childThreadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/threadOrchestration/CoordinatorUpdates") {}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const coordinators = yield* ThreadCoordinators;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const serial = yield* Semaphore.make(1);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableThreadOrchestration),
    Effect.orElseSucceed(() => false),
  );

  /** Appends to the coordinator's waiting update message, or queues a new one. */
  const deliver = Effect.fn("CoordinatorUpdates.deliver")(function* (
    coordinatorId: ThreadId,
    block: string,
  ) {
    const queue = yield* threads.getThreadRecords(coordinatorId, ["runs", "messages"], {
      messageRoles: ["user"],
    });
    const waiting = queue.runs.flatMap((run) => {
      if (run.status !== "queued") return [];
      const message = queue.messages.find((candidate) => candidate.id === run.userMessageId);
      return message !== undefined &&
        message.createdBy === "system" &&
        parseThreadUpdates(message.text) !== null
        ? [{ run, message }]
        : [];
    })[0];
    if (waiting !== undefined) {
      yield* threads.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make(`fork:coordinator-update:${yield* uuid}`),
        threadId: coordinatorId,
        runId: waiting.run.id,
        text: `${waiting.message.text}\n${block}`,
      });
      return;
    }
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`fork:coordinator-update:${yield* uuid}`),
      threadId: coordinatorId,
      messageId: MessageId.make(`fork-update:${yield* uuid}`),
      text: block,
      attachments: [],
      createdBy: "system",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
  });

  const reportOnce = Effect.fn("CoordinatorUpdates.report")(function* (childThreadId: ThreadId) {
    if (!(yield* enabled)) return;
    const child = yield* threads.getThreadShell(childThreadId);
    if (child === null || child.deletedAt !== null) return;
    const coordinatorId = yield* coordinators.coordinatorOf(child);
    if (coordinatorId === null) return;
    const controls = yield* threads.getThreadRecords(
      childThreadId,
      ["runs", "messages", "subagents", "providerThreads"],
      { messageRoles: ["user"] },
    );
    const progress = delegatedTaskProgress(controls);
    if (progress.state !== "result_available" || progress.resultRun === undefined) return;
    const resultRun = progress.resultRun;
    const coordinator = yield* threads.getThreadShell(coordinatorId);
    const lineageParent =
      child.lineage.relationshipToParent === "subagent" &&
      child.lineage.parentThreadId === coordinatorId;
    const parentRecords = lineageParent
      ? yield* threads.getThreadRecords(coordinatorId, ["subagents", "contextTransfers"])
      : null;
    const decision = decideCoordinatorUpdate({
      child,
      coordinator,
      resultRunId: resultRun.id,
      lastReportedRunId: yield* coordinators.lastReportedRun(childThreadId),
      lineageTask: parentRecords?.subagents.find(
        (task) => task.origin === "app_owned" && task.childThreadId === childThreadId,
      ),
      resultTransferRunIds: (parentRecords?.contextTransfers ?? []).flatMap((transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === childThreadId &&
        transfer.sourcePoint.runId !== undefined
          ? [transfer.sourcePoint.runId]
          : [],
      ),
    });
    if (decision.kind === "wait") return;
    if (decision.kind === "skip") {
      if (decision.accounted !== null) {
        yield* coordinators.markReported(childThreadId, decision.accounted);
      }
      return;
    }
    const result = yield* threads.getThreadRecords(childThreadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [resultRun.id],
      turnItemRunId: resultRun.id,
      turnItemTypes: ["assistant_message", "error"],
    });
    const answer = subagentResultForRun(result, resultRun).text;
    yield* deliver(coordinatorId, childUpdateBlock({ child, answer }));
    yield* coordinators.markReported(childThreadId, decision.runId);
  });

  const report = (childThreadId: ThreadId) =>
    serial
      .withPermits(1)(reportOnce(childThreadId))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("coordinator-updates.report-failed", { childThreadId, cause }),
        ),
      );

  const start = () =>
    threads.streamDomainEvents.pipe(
      Stream.map((event): ReadonlyArray<ThreadId> => {
        if (event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status)) {
          return [event.threadId];
        }
        // V2 publishes a delegated child's result to its parent after the
        // run ended; that decides whether V2 or this reactor reports it.
        if (
          event.type === "subagent.updated" &&
          event.payload.origin === "app_owned" &&
          event.payload.childThreadId !== null &&
          TERMINAL_TASK_STATUSES.has(event.payload.status)
        ) {
          return [event.payload.childThreadId];
        }
        return [];
      }),
      Stream.flattenIterable,
      Stream.runForEach(report),
      Effect.catchCause((cause) =>
        Effect.logWarning("coordinator-updates.stream-failed", { cause }),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    );

  return CoordinatorUpdates.of({ start, report });
});

export const layer = Layer.effect(CoordinatorUpdates, make);

export const startedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const updates = yield* CoordinatorUpdates;
    yield* updates.start();
  }),
).pipe(Layer.provideMerge(layer));
