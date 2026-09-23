/**
 * Fork: thread orchestration. Tells a coordinator thread when one of its
 * children needs attention: it finished, failed, stopped, opened a pull
 * request, or waits on the user. The update is a turn on the coordinator, so
 * it can follow up, start the next thread or combine results without polling.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  type ChildThreadState,
  describeChildThread,
  resolveChildThreadState,
  wrapThreadUpdate,
} from "@t3tools/shared/threadOrchestration";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

export class ThreadOrchestrationReactor extends Context.Service<
  ThreadOrchestrationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/threadOrchestration/ThreadOrchestrationReactor") {}

/**
 * A child's turn can end while its background tasks still run; it only counts
 * as finished once they are gone. When the last one ends, the provider wakes
 * the agent for a new turn, and that turn's end reports the child. Should no
 * turn follow, the child is reported after this grace period instead.
 */
const BACKGROUND_SETTLE_GRACE = "30 seconds";

/** The coordinator reads the child's answer from the update; long ones stay readable. */
const UPDATE_ANSWER_MAX_LENGTH = 6_000;

type UpdateRequest =
  | {
      readonly kind: "report";
      readonly threadId: ThreadId;
      /** Set when the event was a new approval or question: the request it announces. */
      readonly requestActivityId?: string;
    }
  | {
      /** A coordinator was settled or brought back; its children follow. */
      readonly kind: "settle-children" | "unsettle-children";
      readonly threadId: ThreadId;
    };

export interface ChildUpdate {
  /** Identifies what the update reports, so the same finish is never reported twice. */
  readonly key: string;
  readonly state: ChildThreadState;
}

/**
 * What a child's current shell should tell its coordinator, or null while it
 * is still working. A settled child is keyed by its latest answer, a blocked
 * one by the request it waits on.
 */
export function childUpdateFor(input: {
  readonly child: OrchestrationThreadShell;
  readonly latestAnswerId: string | null;
  readonly requestActivityId: string | undefined;
}): ChildUpdate | null {
  const state = resolveChildThreadState(input.child);
  if (state === "working") return null;
  if (state === "waiting") {
    return input.requestActivityId ? { key: `waiting:${input.requestActivityId}`, state } : null;
  }
  // A failure that ends a turn before its first answer still has to be reported once.
  const anchor = input.latestAnswerId ?? input.child.session?.updatedAt ?? input.child.updatedAt;
  return { key: `${state}:${anchor}`, state };
}

function clampAnswer(text: string): string {
  return text.length > UPDATE_ANSWER_MAX_LENGTH
    ? `${text.slice(0, UPDATE_ANSWER_MAX_LENGTH)}\n… (${text.length - UPDATE_ANSWER_MAX_LENGTH} more characters; read_thread returns all of it)`
    : text;
}

export function childUpdateBody(input: {
  readonly state: ChildThreadState;
  readonly latestAnswer: string | null;
}): string {
  if (input.state === "waiting") {
    return "It is blocked until the user answers in that thread. If you know the answer, tell it with send_to_thread.";
  }
  return input.latestAnswer?.trim() ? clampAnswer(input.latestAnswer) : "(It gave no answer.)";
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** Last update each child sent, so replays and repeated session writes stay quiet. */
  const reported = new Map<ThreadId, string>();
  /** Threads with a background-settle check scheduled, so a burst of task ends schedules one. */
  const settleChecks = new Set<ThreadId>();

  /**
   * Settling a coordinator settles its children, and bringing it back brings
   * them back. The decider keeps a child that still works or waits on an
   * approval open, so only finished work goes away with its coordinator.
   */
  const followCoordinator = Effect.fn("ThreadOrchestrationReactor.followCoordinator")(function* (
    coordinatorId: ThreadId,
    action: "thread.settle" | "thread.unsettle",
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const children = snapshot.threads.filter(
      (thread) =>
        thread.parentThreadId === coordinatorId &&
        thread.archivedAt === null &&
        (action === "thread.settle" ? thread.settledAt === null : thread.settledAt !== null),
    );
    yield* Effect.forEach(
      children,
      (child) =>
        Effect.gen(function* () {
          const commandId = CommandId.make(
            `server:thread-orchestration-${action}:${child.id}:${yield* uuid}`,
          );
          yield* engine.dispatch(
            action === "thread.settle"
              ? { type: action, commandId, threadId: child.id }
              : { type: action, commandId, threadId: child.id, reason: "user" },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("child thread did not follow its coordinator", {
                  action,
                  threadId: child.id,
                }),
          ),
        ),
      { discard: true },
    );
  });

  const report = Effect.fn("ThreadOrchestrationReactor.report")(function* (
    request: Extract<UpdateRequest, { kind: "report" }>,
  ) {
    const enabled = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.enableThreadOrchestration),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return;
    const child = yield* snapshots.getThreadShellById(request.threadId);
    if (Option.isNone(child) || !child.value.parentThreadId) return;
    const parent = yield* snapshots.getThreadShellById(child.value.parentThreadId);
    if (Option.isNone(parent) || parent.value.archivedAt !== null) return;

    const detail = yield* snapshots.getThreadDetailById(child.value.id);
    const latestAnswer = Option.isSome(detail)
      ? (detail.value.messages.findLast(
          (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
        ) ?? null)
      : null;
    const update = childUpdateFor({
      child: child.value,
      latestAnswerId: latestAnswer?.id ?? null,
      requestActivityId: request.requestActivityId,
    });
    if (update === null || reported.get(child.value.id) === update.key) return;
    reported.set(child.value.id, update.key);

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:thread-orchestration-update:${yield* uuid}`),
      threadId: parent.value.id,
      message: {
        messageId: MessageId.make(yield* uuid),
        role: "user",
        text: wrapThreadUpdate({
          threadId: child.value.id,
          title: child.value.title,
          state: update.state,
          detail: describeChildThread(child.value),
          text: childUpdateBody({ state: update.state, latestAnswer: latestAnswer?.text ?? null }),
        }),
        attachments: [],
      },
      modelSelection: parent.value.modelSelection,
      runtimeMode: parent.value.runtimeMode,
      interactionMode: parent.value.interactionMode,
      createdAt: yield* nowIso,
    });
  });

  const worker = yield* makeDrainableWorker((request: UpdateRequest) =>
    (request.kind === "report"
      ? report(request)
      : followCoordinator(
          request.threadId,
          request.kind === "settle-children" ? "thread.settle" : "thread.unsettle",
        )
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread orchestration update failed", {
              threadId: request.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const scheduleSettleCheck = (threadId: ThreadId) => {
    if (settleChecks.has(threadId)) return Effect.void;
    settleChecks.add(threadId);
    return Effect.sleep(BACKGROUND_SETTLE_GRACE).pipe(
      Effect.andThen(Effect.sync(() => settleChecks.delete(threadId))),
      Effect.andThen(worker.enqueue({ kind: "report", threadId })),
      Effect.forkScoped,
      Effect.asVoid,
    );
  };

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.session-set":
        if (
          event.payload.session.status !== "running" &&
          event.payload.session.status !== "starting"
        ) {
          return worker.enqueue({ kind: "report", threadId: event.payload.threadId });
        }
        break;
      case "thread.activity-appended": {
        const { activity } = event.payload;
        if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
          return worker.enqueue({
            kind: "report",
            threadId: event.payload.threadId,
            requestActivityId: activity.id,
          });
        }
        if (activity.kind === "task.completed") {
          return scheduleSettleCheck(event.payload.threadId);
        }
        break;
      }
      case "thread.settled":
        return worker.enqueue({ kind: "settle-children", threadId: event.payload.threadId });
      // Only the user's unsettle: a coordinator woken by a child's update
      // must not pull every other finished child back with it.
      case "thread.unsettled":
        if (event.payload.reason === "user") {
          return worker.enqueue({ kind: "unsettle-children", threadId: event.payload.threadId });
        }
        break;
      case "thread.deleted":
        reported.delete(event.payload.threadId);
        break;
    }
    return Effect.void;
  };

  const start = Effect.fn("ThreadOrchestrationReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies ThreadOrchestrationReactor["Service"];
});

export const layer = Layer.effect(ThreadOrchestrationReactor, make);

/**
 * Starts itself with the server rather than through OrchestrationReactor, so
 * the fork adds one layer instead of a dependency every reactor test provides.
 */
export const startedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ThreadOrchestrationReactor;
    yield* reactor.start();
  }),
).pipe(Layer.provideMerge(layer));
