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
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  type ChildThreadState,
  describeChildThread,
  parseThreadUpdates,
  resolveChildThreadState,
  wrapThreadUpdate,
} from "@t3tools/shared/threadOrchestration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
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

/**
 * A turn that ends is reported only when no new one starts right after it: a
 * queued message or a woken agent carries straight on, and the coordinator
 * hears about the turn that really ends.
 */
export const TURN_END_DEBOUNCE = Duration.seconds(3);

/**
 * Updates for one coordinator that come in within this window arrive as one
 * turn with one block per child, instead of a turn each.
 */
export const UPDATE_BUNDLE_WINDOW = Duration.seconds(2);

/**
 * A child whose turn ended but whose subagents or background commands show no
 * activity for this long is reported anyway, so the coordinator is not left
 * waiting on work that may hang.
 */
export const BACKGROUND_STALL_LIMIT = Duration.minutes(30);

/**
 * Background tasks that only watch (Monitor tool, MCP and artifact watches).
 * They run until stopped, so they never hold up a child's result. Background
 * shells (`local_bash`, `shell`) count as work: they are builds and test runs
 * as often as log tails, and the agent is woken when they end.
 */
const WATCH_TASK_TYPES: ReadonlySet<string> = new Set(["monitor", "monitor_mcp", "monitor_ws"]);

/** The update carries a summary of the child's answer; read_thread has the rest. */
const UPDATE_ANSWER_MAX_LENGTH = 1_200;

type UpdateRequest =
  | {
      readonly kind: "report";
      readonly threadId: ThreadId;
      /** Set when the event was a new approval or question: the request it announces. */
      readonly requestActivityId?: string;
      /** Set when the child's background work showed no activity for BACKGROUND_STALL_LIMIT. */
      readonly stalled?: boolean;
    }
  | {
      /** A coordinator was settled or brought back; its children follow. */
      readonly kind: "settle-children" | "unsettle-children";
      readonly threadId: ThreadId;
    }
  | {
      /** The bundle window of this coordinator closed: send what it collected. */
      readonly kind: "flush";
      readonly threadId: ThreadId;
    };

/**
 * What still runs in a child after its turn ended: nothing, only watches, or
 * real work (subagents, workflows, background commands) that holds it up.
 */
export type ChildBackground =
  | { readonly kind: "none" }
  | { readonly kind: "watches"; readonly count: number }
  | { readonly kind: "work"; readonly stalled: boolean };

function turnIsRunning(child: Pick<OrchestrationThreadShell, "session" | "latestTurn">): boolean {
  return (
    child.session?.status === "starting" ||
    child.session?.status === "running" ||
    child.latestTurn?.state === "running"
  );
}

export function childBackgroundFor(input: {
  readonly child: Pick<OrchestrationThreadShell, "session" | "latestTurn" | "backgroundLiveness">;
  readonly liveTaskTypes: ReadonlyArray<string | undefined>;
  readonly stalled: boolean;
}): ChildBackground {
  if (input.child.backgroundLiveness == null || turnIsRunning(input.child)) return { kind: "none" };
  const watchesOnly =
    input.liveTaskTypes.length > 0 &&
    input.liveTaskTypes.every((type) => type !== undefined && WATCH_TASK_TYPES.has(type));
  return watchesOnly
    ? { kind: "watches", count: input.liveTaskTypes.length }
    : { kind: "work", stalled: input.stalled };
}

/** The child as its coordinator sees it: watches do not keep it working. */
function asReported(
  child: OrchestrationThreadShell,
  background: ChildBackground,
): OrchestrationThreadShell {
  return background.kind === "watches" ? { ...child, backgroundLiveness: null } : child;
}

/** The detail line of an update, with what still runs in the child. */
export function childUpdateDetail(input: {
  readonly child: OrchestrationThreadShell;
  readonly background: ChildBackground;
}): string {
  const detail = describeChildThread(asReported(input.child, input.background));
  if (input.background.kind === "watches") {
    const { count } = input.background;
    return `${detail}; ${count} ${count === 1 ? "watch" : "watches"} still running`;
  }
  if (input.background.kind === "work" && input.background.stalled) {
    return `${detail}, no activity for ${Duration.toMinutes(BACKGROUND_STALL_LIMIT)} min`;
  }
  return detail;
}

export interface ChildUpdate {
  /** Identifies what the update reports, so the same finish is never reported twice. */
  readonly key: string;
  readonly state: ChildThreadState;
}

/**
 * What a child's current shell should tell its coordinator, or null while it
 * is still working. A settled child is keyed by its latest prompt and answer,
 * a blocked one by the request it waits on. The prompt makes each follow-up a
 * result of its own: a retry that fails again without a new answer is news.
 */
export function childUpdateFor(input: {
  readonly child: OrchestrationThreadShell;
  readonly latestPromptId: string | null;
  readonly latestAnswerId: string | null;
  readonly requestActivityId: string | undefined;
  readonly background?: ChildBackground;
}): ChildUpdate | null {
  const background = input.background ?? { kind: "none" };
  const state = resolveChildThreadState(asReported(input.child, background));
  const stalled = state === "working" && background.kind === "work" && background.stalled;
  if (state === "working" && !stalled) return null;
  if (state === "waiting") {
    return input.requestActivityId ? { key: `waiting:${input.requestActivityId}`, state } : null;
  }
  // A failure that ends a turn before its first answer still has to be reported once.
  const anchor = input.latestAnswerId ?? input.child.session?.updatedAt ?? input.child.updatedAt;
  const kind = stalled ? "stalled" : state;
  return {
    key: input.latestPromptId ? `${kind}:${input.latestPromptId}:${anchor}` : `${kind}:${anchor}`,
    state,
  };
}

/**
 * Whether the coordinator already holds an update in this state about the
 * child, sent after `since` (the answer or failure the update would report).
 * The reactor's memory of sent updates is gone after a server restart; this
 * keeps a later session write, such as the stop that settling a child
 * triggers, from reporting an old finish again.
 */
export function coordinatorHasUpdate(input: {
  readonly coordinatorMessages: ReadonlyArray<
    Pick<OrchestrationMessage, "role" | "text" | "createdAt">
  >;
  readonly childId: ThreadId;
  readonly state: ChildThreadState;
  readonly since: string;
}): boolean {
  const since = Date.parse(input.since);
  return input.coordinatorMessages.some((message) => {
    if (message.role !== "user" || Date.parse(message.createdAt) < since) return false;
    return (parseThreadUpdates(message.text) ?? []).some(
      (update) => update.threadId === input.childId && update.state === input.state,
    );
  });
}

/**
 * Whether the answer came after the latest prompt. A follow-up that failed or
 * stopped before answering must not pass the previous answer off as its own.
 */
export function answersLatestPrompt<A extends Pick<OrchestrationMessage, "createdAt">>(
  answer: A | null,
  prompt: Pick<OrchestrationMessage, "createdAt"> | null,
): answer is A {
  if (answer === null) return false;
  return prompt === null || Date.parse(answer.createdAt) >= Date.parse(prompt.createdAt);
}

function latestOf(first: string, second: string | undefined): string {
  return second !== undefined && Date.parse(second) > Date.parse(first) ? second : first;
}

/**
 * The start of a long answer, cut at the last paragraph or sentence end that
 * fits, so the summary never stops mid-sentence when it can avoid it.
 */
export function clampAnswer(text: string, maxLength = UPDATE_ANSWER_MAX_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const window = trimmed.slice(0, maxLength);
  const atLeast = Math.floor(maxLength / 2);
  const lastEnd = (pattern: RegExp) => {
    let end = -1;
    for (const match of window.matchAll(pattern)) {
      const at = match.index + match[0].trimEnd().length;
      if (at >= atLeast) end = at;
    }
    return end;
  };
  const cut = [/\n\s*\n/g, /[.!?:](?=\s)/g, /\s/g].map(lastEnd).find((end) => end > 0);
  const summary = window.slice(0, cut ?? maxLength).trimEnd();
  return `${summary}\n… (${trimmed.length - summary.length} more characters; read_thread returns all of it)`;
}

export function childUpdateBody(input: {
  readonly state: ChildThreadState;
  readonly latestAnswer: string | null;
  readonly background?: ChildBackground;
}): string {
  if (input.state === "waiting") {
    return "It is blocked until the user answers in that thread. If you know the answer, tell it with send_to_thread.";
  }
  const answer = input.latestAnswer?.trim()
    ? clampAnswer(input.latestAnswer)
    : "(It gave no answer.)";
  if (input.background?.kind === "work" && input.background.stalled) {
    return `${answer}\n\n(Its turn ended, but its subagents or background commands still run without any sign of activity. You get another update when they finish; stop_thread ends them.)`;
  }
  return answer;
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** Last update each child sent, so replays and repeated session writes stay quiet. */
  const reported = new Map<ThreadId, string>();
  /** Threads with a background-settle check scheduled, so a burst of task ends schedules one. */
  const settleChecks = new Set<ThreadId>();
  /** Report checks waiting out TURN_END_DEBOUNCE; a new turn of the thread cancels its check. */
  const turnEndChecks = new Map<ThreadId, Fiber.Fiber<void>>();
  /** Children held up by background work, with the time of their last activity. */
  const stallWatches = new Map<ThreadId, number>();
  /** Update blocks collected per coordinator until its bundle window closes. */
  const outbox = new Map<ThreadId, Array<string>>();

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
    // Settling says its result has been dealt with; the session stop that
    // follows a settle is no news. New work unsettles the child first.
    if (child.value.settledAt !== null && request.requestActivityId === undefined) return;
    const parent = yield* snapshots.getThreadShellById(child.value.parentThreadId);
    if (Option.isNone(parent) || parent.value.archivedAt !== null) return;

    const detail = yield* snapshots.getThreadDetailById(child.value.id);
    const messages = Option.isSome(detail) ? detail.value.messages : [];
    const latestAnswer =
      messages.findLast(
        (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
      ) ?? null;
    const latestPrompt = messages.findLast((message) => message.role === "user") ?? null;
    const background = childBackgroundFor({
      child: child.value,
      liveTaskTypes: liveness.getLiveTaskTypes(child.value.id),
      stalled: request.stalled === true,
    });
    if (background.kind === "work") {
      if (!background.stalled) yield* watchForStall(child.value.id);
    } else {
      stallWatches.delete(child.value.id);
    }
    const update = childUpdateFor({
      child: child.value,
      latestPromptId: latestPrompt?.id ?? null,
      latestAnswerId: latestAnswer?.id ?? null,
      requestActivityId: request.requestActivityId,
      background,
    });
    if (update === null || reported.get(child.value.id) === update.key) return;
    if (!reported.has(child.value.id) && update.state !== "waiting") {
      const coordinatorDetail = yield* snapshots.getThreadDetailById(parent.value.id);
      const sent =
        Option.isSome(coordinatorDetail) &&
        coordinatorHasUpdate({
          coordinatorMessages: coordinatorDetail.value.messages,
          childId: child.value.id,
          state: update.state,
          since: latestOf(
            latestAnswer?.createdAt ?? child.value.session?.updatedAt ?? child.value.updatedAt,
            latestPrompt?.createdAt,
          ),
        });
      if (sent) {
        reported.set(child.value.id, update.key);
        return;
      }
    }
    reported.set(child.value.id, update.key);

    const block = wrapThreadUpdate({
      threadId: child.value.id,
      title: child.value.title,
      state: update.state,
      detail: childUpdateDetail({ child: child.value, background }),
      text: childUpdateBody({
        state: update.state,
        latestAnswer: answersLatestPrompt(latestAnswer, latestPrompt) ? latestAnswer.text : null,
        background,
      }),
    });
    const pending = outbox.get(parent.value.id);
    if (pending) {
      pending.push(block);
      return;
    }
    outbox.set(parent.value.id, [block]);
    yield* Effect.sleep(UPDATE_BUNDLE_WINDOW).pipe(
      Effect.andThen(worker.enqueue({ kind: "flush", threadId: parent.value.id })),
      Effect.forkIn(scope),
    );
  });

  /**
   * Sends a coordinator the updates its bundle window collected, as one turn.
   * While the coordinator still runs a turn, the provider hands the message
   * to that turn or queues it, as it does with the user's messages.
   */
  const flush = Effect.fn("ThreadOrchestrationReactor.flush")(function* (coordinatorId: ThreadId) {
    const blocks = outbox.get(coordinatorId);
    outbox.delete(coordinatorId);
    if (!blocks || blocks.length === 0) return;
    const parent = yield* snapshots.getThreadShellById(coordinatorId);
    if (Option.isNone(parent) || parent.value.archivedAt !== null) return;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:thread-orchestration-update:${yield* uuid}`),
      threadId: parent.value.id,
      message: {
        messageId: MessageId.make(yield* uuid),
        role: "user",
        text: blocks.join("\n\n"),
        attachments: [],
      },
      modelSelection: parent.value.modelSelection,
      runtimeMode: parent.value.runtimeMode,
      interactionMode: parent.value.interactionMode,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Reports a child held up by background work once that work has shown no
   * activity for BACKGROUND_STALL_LIMIT. Any event of the child resets the
   * clock (see processEvent); a report that finds it no longer held up ends
   * the watch.
   */
  const watchForStall = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (stallWatches.has(threadId)) return;
      stallWatches.set(threadId, yield* Clock.currentTimeMillis);
      yield* Effect.gen(function* () {
        while (true) {
          const lastActivity = stallWatches.get(threadId);
          if (lastActivity === undefined) return;
          const quietFor = (yield* Clock.currentTimeMillis) - lastActivity;
          const remaining = Duration.toMillis(BACKGROUND_STALL_LIMIT) - quietFor;
          if (remaining <= 0) {
            stallWatches.delete(threadId);
            yield* worker.enqueue({ kind: "report", threadId, stalled: true });
            return;
          }
          yield* Effect.sleep(Duration.millis(remaining));
        }
      }).pipe(Effect.forkIn(scope));
    });

  // Annotated: report schedules follow-ups on the worker that runs it.
  const worker: DrainableWorker<UpdateRequest> = yield* makeDrainableWorker(
    (request: UpdateRequest) =>
      (request.kind === "report"
        ? report(request)
        : request.kind === "flush"
          ? flush(request.threadId)
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

  const scheduleTurnEndCheck = (threadId: ThreadId) => {
    if (turnEndChecks.has(threadId)) return Effect.void;
    return Effect.sleep(TURN_END_DEBOUNCE).pipe(
      Effect.andThen(Effect.sync(() => turnEndChecks.delete(threadId))),
      Effect.andThen(worker.enqueue({ kind: "report", threadId })),
      Effect.forkIn(scope),
      Effect.map((fiber) => {
        turnEndChecks.set(threadId, fiber);
      }),
    );
  };

  const cancelTurnEndCheck = (threadId: ThreadId) => {
    const fiber = turnEndChecks.get(threadId);
    if (fiber === undefined) return Effect.void;
    turnEndChecks.delete(threadId);
    return Fiber.interrupt(fiber);
  };

  const processEvent = (event: OrchestrationEvent) => {
    if (event.aggregateKind === "thread" && stallWatches.has(event.aggregateId as ThreadId)) {
      return Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          stallWatches.set(event.aggregateId as ThreadId, now);
        }),
        Effect.andThen(handleEvent(event)),
      );
    }
    return handleEvent(event);
  };

  const handleEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.session-set":
        if (
          event.payload.session.status !== "running" &&
          event.payload.session.status !== "starting"
        ) {
          return scheduleTurnEndCheck(event.payload.threadId);
        }
        return cancelTurnEndCheck(event.payload.threadId);
      case "thread.turn-start-requested":
        return cancelTurnEndCheck(event.payload.threadId);
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
        stallWatches.delete(event.payload.threadId);
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
