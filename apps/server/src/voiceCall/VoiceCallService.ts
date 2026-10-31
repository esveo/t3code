/**
 * Fork: one voice call per environment. The client's WebRTC peer carries the
 * audio; this service creates each realtime session (a segment), holds its
 * sideband, hands the voice's delegations to the call's thread and tells
 * every client how the call stands. See docs/internals/voice-call.md.
 */
import {
  CommandId,
  DEFAULT_VOICE_CALL_VOICE,
  MessageId,
  type OrchestrationMessageContext,
  type ThreadId,
  type VoiceCallAvailability,
  type VoiceCallConnectInput,
  type VoiceCallConnectResult,
  VoiceCallDelegation,
  VoiceCallError,
  type VoiceCallEvent,
  type VoiceCallStatus,
  type VoiceCallThreadSpan,
  type VoiceCallUsage,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RealtimeCallClient, type RealtimeSideband } from "./RealtimeCallClient.ts";
import {
  delegationAnswerEvents,
  type RealtimeEvent,
  type RealtimeOutbound,
  type RealtimeSpeaker,
  sessionUpdateEvents,
} from "./realtimeEvents.ts";
import { readVoiceCallAuth, readVoiceCallPlanType } from "./VoiceCallAuth.ts";
import { makeVoiceCallThreadSpans } from "./VoiceCallThreadSpans.ts";
import { makeVoiceCallUsageTracker } from "./VoiceCallUsage.ts";
import {
  alreadyForwardedAnswer,
  archivedTargetAnswer,
  BACKEND_HINT,
  dispatchFailedAnswer,
  frontEndInstructions,
  type VoiceCallFollowUpBehavior,
  type VoiceCallRecapTurn,
  noTargetAnswer,
  completeVoiceDelegation,
  parseVoiceDelegation,
  stripLeadingMarks,
  targetMovedContext,
  voiceCallSendMode,
  voiceSayContext,
} from "./voiceCallPrompt.ts";

export const VOICE_CALL_CONTEXT_KIND = "voice-call";

const VOICE_CALLS_OFF = "Voice calls are off in Settings.";

export interface VoiceCallSegmentHandle {
  readonly id: string;
  readonly send: (event: RealtimeOutbound) => Effect.Effect<void>;
}

export class VoiceCallService extends Context.Service<
  VoiceCallService,
  {
    readonly subscribe: (clientId: string) => Stream.Stream<VoiceCallEvent>;
    readonly connect: (
      input: VoiceCallConnectInput,
    ) => Effect.Effect<VoiceCallConnectResult, VoiceCallError>;
    readonly setTarget: (target: ThreadId | null) => Effect.Effect<void>;
    readonly pause: Effect.Effect<void>;
    readonly hangUp: Effect.Effect<void>;
    readonly usage: Effect.Effect<VoiceCallUsage>;
    readonly threadSpans: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<VoiceCallThreadSpan>>;
    /**
     * Answers a delegation once the user is quiet. With no live segment the
     * answer waits for the next one, also across a hang-up or a restart.
     */
    readonly answerDelegation: (delegationId: string, text: string) => Effect.Effect<void>;
    /** Something the voice should say unprompted; dropped when no call is live. */
    readonly speak: (text: string) => Effect.Effect<void>;
    /** `voice_say`: returns when the voice said it or the user's interruption reached the thread. */
    readonly say: (threadId: ThreadId, text: string) => Effect.Effect<VoiceSayStatus>;
    /** Whether the thread used `voice_say` since the last call; then its answer is not read back. */
    readonly takeSaid: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly delegations: Effect.Effect<ReadonlyArray<VoiceCallDelegation>>;
    readonly targetThreadId: Effect.Effect<ThreadId | null>;
    readonly live: Effect.Effect<boolean>;
    readonly updateDelegation: (
      delegationId: string,
      patch: Partial<Pick<VoiceCallDelegation, "status" | "answer">>,
    ) => Effect.Effect<void>;
  }
>()("t3/voiceCall/VoiceCallService") {}

interface Segment {
  readonly id: string;
  readonly scope: Scope.Closeable;
  readonly sideband: RealtimeSideband;
  readonly turnSpeakers: Map<string, RealtimeSpeaker>;
  /** Speaking gate: open turns by the time they opened, the user's last word, the next re-check. */
  readonly openTurns: Map<string, number>;
  lastUserSpeechAt: number;
  wakeAt: number | null;
  /** The user turn that broke into a `voice_say`, until it ended. */
  interruption: { readonly turnId: string; delegated: boolean } | null;
  /** When an interruption went to the thread; the voice may still delegate the same words. */
  forwardedAt: number | null;
  /** The user's words since the last delegation or real answer, across pauses that split turns. */
  heard: string;
}

export type VoiceSayStatus = "spoken" | "interrupted" | "call_ended" | "no_call" | "timed_out";

interface Say {
  readonly deferred: Deferred.Deferred<VoiceSayStatus>;
  injected: boolean;
}

/** Something waiting for the speaking gate; `delegation` null is an unprompted update. */
interface Injection {
  readonly delegation: VoiceCallDelegation | null;
  readonly text: string;
  readonly queuedAt: number;
  readonly say?: Say;
}

const RECAP_TURNS = 8;
/** A context payload over 64,000 characters is dropped whole, so the oldest lines go first. */
const TRANSCRIPT_MAX_CHARS = 32_000;
const SAY_TIMEOUT_MS = 120_000;
const FORWARDED_DELEGATION_WINDOW_MS = 20_000;

/** Answering a held delegation works for at least 180 s (spike); later ones go out unprompted. */
const DELEGATION_ANSWER_WINDOW_MS = 180_000;
/** Tuning value: the user may pause mid-sentence; nothing is injected until they were quiet this long. */
const QUIET_AFTER_USER_MS = 1_500;
/** A turn that never reports done must not hold the queue forever; counted from the user's last word. */
const STALE_TURN_MS = 30_000;
/** Results nobody heard within this time are dropped instead of opening the next call. */
const PENDING_MAX_AGE_MS = 60 * 60_000;

const contextIdFor = (delegationId: string) =>
  `voice-${delegationId.replace(/[^a-z0-9_-]/gi, "").slice(-100)}`;

/** The steered message: a voice chip, then the voice's instruction. */
export const voiceDelegationMessage = (input: {
  readonly callId: string;
  readonly delegationId: string;
  readonly text: string;
  readonly transcript: string;
}): { readonly text: string; readonly context: OrchestrationMessageContext } => {
  const contextId = contextIdFor(input.delegationId);
  const reference = formatComposerContextReference({
    kind: VOICE_CALL_CONTEXT_KIND,
    contextId: contextId as never,
    label: "Voice",
  });
  return {
    text: `${reference} ${input.text}`,
    context: {
      version: 1,
      records: [
        {
          version: 1,
          contextId: contextId as never,
          label: "Voice",
          kind: VOICE_CALL_CONTEXT_KIND,
          payload: {
            hint: BACKEND_HINT,
            callId: input.callId,
            delegationId: input.delegationId,
            ...(input.transcript.length > 0 ? { transcript: input.transcript } : {}),
          },
        },
      ],
    },
  };
};

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const threads = yield* ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const realtime = yield* RealtimeCallClient;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lifecycle = yield* Semaphore.make(1);
  const usageTracker = yield* makeVoiceCallUsageTracker;
  const threadSpans = yield* makeVoiceCallThreadSpans;
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<VoiceCallEvent>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );

  let call: VoiceCallStatus | null = null;
  let segment: Segment | null = null;
  let pending: Array<Injection> = [];
  let says: Array<Say> = [];
  let followUpBehavior: VoiceCallFollowUpBehavior = "steer";
  /** A new session after a pause knows nothing of the call, so it is told the last turns. */
  let recap: ReadonlyArray<VoiceCallRecapTurn> = [];
  /** What was said since the last delegation; it rides along, as in Codex's `transcript_delta`. */
  let unsentTranscript: ReadonlyArray<string> = [];
  /** The delegation can arrive before its own turn ends; that turn must not ride on the next one. */
  let lastSteeredText: string | null = null;
  /** A paused call owes its results too; they wait for the next segment. */
  const carriesCall = () => segment !== null || call?.state === "paused";
  const saidThreads = new Set<ThreadId>();
  const delegations = new Map<string, VoiceCallDelegation>();
  const subscriptions = new Map<string, number>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const publish = (event: VoiceCallEvent) => PubSub.publish(changes, event).pipe(Effect.asVoid);
  const publishCall = Effect.suspend(() => publish({ type: "call", call }));
  const setCall = (patch: Partial<VoiceCallStatus>) =>
    Effect.suspend(() => {
      if (call === null) return Effect.void;
      call = { ...call, ...patch };
      return publishCall;
    });
  const recordDelegation = (delegation: VoiceCallDelegation) =>
    Effect.suspend(() => {
      delegations.set(delegation.id, delegation);
      return publish({ type: "delegation", delegation });
    });

  const readAuth = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new VoiceCallError({ message: "Could not read the settings." })),
    );
    if (!settings.voiceCallEnabled) {
      return yield* new VoiceCallError({ message: VOICE_CALLS_OFF });
    }
    const auth = yield* readVoiceCallAuth(settings).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return { settings, auth };
  });

  const availability: Effect.Effect<VoiceCallAvailability> = readAuth.pipe(
    Effect.map(({ auth }) =>
      auth._tag === "ready" ? { available: true, reason: null, message: null } : auth.availability,
    ),
    Effect.catch((error) =>
      Effect.succeed({ available: false, reason: null, message: error.message }),
    ),
  );

  const sendAll = (events: ReadonlyArray<RealtimeOutbound>) =>
    Effect.suspend(() => {
      const current = segment;
      if (current === null) return Effect.void;
      return Effect.forEach(events, current.sideband.send, { discard: true }).pipe(
        Effect.catch((error) => Effect.logWarning("voice call: send failed", error.message)),
      );
    });

  const settleSays = (status: VoiceSayStatus, matches: (say: Say) => boolean = () => true) =>
    Effect.suspend(() => {
      const settled = says.filter(matches);
      says = says.filter((say) => !matches(say));
      pending = pending.filter((item) => item.say === undefined || !settled.includes(item.say));
      return Effect.forEach(settled, (say) => Deferred.succeed(say.deferred, status), {
        discard: true,
      });
    });

  /** Closing the scope sends `session.close`; the realtime session stops billing. */
  const closeSegment = Effect.suspend(() => {
    const current = segment;
    segment = null;
    return Effect.andThen(
      settleSays("call_ended"),
      current === null
        ? Effect.void
        : usageTracker.segmentClosed.pipe(
            Effect.andThen(threadSpans.closed),
            Effect.andThen(Scope.close(current.scope, Exit.void)),
          ),
    );
  });

  /** An answer older than the window, or from a closed segment, can only go out unprompted. */
  const injectionEvents = (current: Segment, item: Injection, now: number) => {
    const delegation = item.delegation;
    if (delegation === null) return sessionUpdateEvents(item.text);
    const age = now - DateTime.toEpochMillis(DateTime.makeUnsafe(delegation.createdAt));
    return delegation.segmentId === current.id && age <= DELEGATION_ANSWER_WINDOW_MS
      ? delegationAnswerEvents(delegation.id, item.text)
      : sessionUpdateEvents(`Result of the earlier request "${delegation.text}". ${item.text}`);
  };

  /**
   * The speaking gate: injections wait until no turn is open and the user has
   * been quiet for a moment, so the voice never talks over them. Barge-in
   * while the voice speaks an injection is left to the model.
   */
  const flush: Effect.Effect<void> = Effect.gen(function* () {
    const current = segment;
    if (current === null || pending.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const readyAt = Math.max(
      current.lastUserSpeechAt + QUIET_AFTER_USER_MS,
      ...[...current.openTurns.values()].map(
        (openedAt) => Math.max(openedAt, current.lastUserSpeechAt) + STALE_TURN_MS,
      ),
    );
    if (now < readyAt) {
      // Events re-check the gate; this timer covers the quiet rule and stale turns.
      if (current.wakeAt === null || readyAt < current.wakeAt) {
        current.wakeAt = readyAt;
        yield* Effect.sleep(Duration.millis(readyAt - now)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (current.wakeAt === readyAt) current.wakeAt = null;
            }),
          ),
          Effect.andThen(Effect.suspend(() => flush)),
          Effect.forkIn(current.scope),
        );
      }
      return;
    }
    const due = pending.filter((item) => now - item.queuedAt <= PENDING_MAX_AGE_MS);
    pending = [];
    for (const item of due) if (item.say !== undefined) item.say.injected = true;
    yield* sendAll(due.flatMap((item) => injectionEvents(current, item, now)));
  });

  const enqueue = Effect.fn("VoiceCallService.enqueue")(function* (
    delegation: VoiceCallDelegation | null,
    text: string,
  ) {
    pending.push({ delegation, text, queuedAt: yield* Clock.currentTimeMillis });
    yield* flush;
  });

  const say = Effect.fn("VoiceCallService.say")(function* (threadId: ThreadId, text: string) {
    if (segment === null || call?.targetThreadId !== threadId) return "no_call" as const;
    const item: Say = { deferred: yield* Deferred.make<VoiceSayStatus>(), injected: false };
    says.push(item);
    saidThreads.add(threadId);
    pending.push({
      delegation: null,
      text: voiceSayContext(text),
      queuedAt: yield* Clock.currentTimeMillis,
      say: item,
    });
    yield* flush;
    return yield* Deferred.await(item.deferred).pipe(
      Effect.timeoutOption(Duration.millis(SAY_TIMEOUT_MS)),
      Effect.map(Option.getOrElse((): VoiceSayStatus => "timed_out")),
      // The agent's run may stop while it waits.
      Effect.ensuring(settleSays("timed_out", (other) => other === item)),
    );
  });

  const endCall = Effect.fn("VoiceCallService.endCall")(function* (error: string | null) {
    yield* closeSegment;
    if (
      call !== null &&
      (call.state === "connecting" || call.state === "live" || call.state === "paused")
    ) {
      yield* setCall({ state: error === null ? "ended" : "error", segmentId: null, error });
    }
  });

  const threadTitle = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.title ?? null),
      Effect.orElseSucceed(() => null),
    );

  const answerDelegation = (delegationId: string, text: string) =>
    Effect.suspend(() => {
      const delegation = delegations.get(delegationId);
      if (delegation === undefined) return Effect.void;
      const answered: VoiceCallDelegation = { ...delegation, status: "answered", answer: text };
      return Effect.andThen(recordDelegation(answered), enqueue(answered, text));
    });

  const steer = Effect.fn("VoiceCallService.steer")(function* (
    callId: string,
    segmentId: string,
    delegationId: string,
    text: string,
    mode: "queue" | "auto",
  ) {
    if (delegations.has(delegationId)) return;
    const targetThreadId = call?.targetThreadId ?? null;
    const base: VoiceCallDelegation = {
      id: delegationId,
      segmentId,
      text,
      threadId: targetThreadId,
      messageId: null,
      runId: null,
      status: "open",
      answer: null,
      createdAt: yield* nowIso,
    };
    const fail = (answer: string) => {
      const failed: VoiceCallDelegation = { ...base, status: "failed", answer };
      return Effect.andThen(recordDelegation(failed), enqueue(failed, answer));
    };
    if (targetThreadId === null) return yield* fail(noTargetAnswer);
    const shell = yield* threads
      .getThreadShell(targetThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return yield* fail(noTargetAnswer);
    if (shell.archivedAt !== null) return yield* fail(archivedTargetAnswer(shell.title));
    const message = voiceDelegationMessage({
      callId,
      delegationId,
      text,
      transcript: unsentTranscript.join("\n").slice(-TRANSCRIPT_MAX_CHARS),
    });
    const sent = yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`voice-call:${callId}:${delegationId}`),
        threadId: targetThreadId,
        messageId: MessageId.make(`voice-call-message:${callId}:${delegationId}`),
        text: message.text,
        context: message.context,
        attachments: [],
        mode,
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.option);
    if (Option.isNone(sent)) return yield* fail(dispatchFailedAnswer(shell.title));
    unsentTranscript = [];
    lastSteeredText = text.trim();
    yield* recordDelegation({
      ...base,
      messageId: sent.value.message.id,
      runId: sent.value.run.id,
    });
  });

  // Untraced: the span below carries the event's attributes.
  const handleEvent = Effect.fnUntraced(
    function* (callId: string, current: Segment, event: RealtimeEvent) {
      const now = yield* Clock.currentTimeMillis;
      switch (event.type) {
        case "turn.created":
          current.turnSpeakers.set(event.turnId, event.speaker);
          current.openTurns.set(event.turnId, now);
          if (event.speaker === "user") {
            current.lastUserSpeechAt = now;
            current.forwardedAt = null;
            current.heard += ` ${event.text}`;
            if (says.length > 0 && current.interruption === null) {
              current.interruption = { turnId: event.turnId, delegated: false };
            }
          }
          // An empty event marks when the turn began; its text arrives later.
          return yield* publish({
            type: "transcript",
            speaker: event.speaker,
            turnId: event.turnId,
            text: event.text,
            done: false,
          });
        case "transcript":
          if (event.speaker === "user") current.lastUserSpeechAt = now;
          return;
        case "turn.delta": {
          const speaker = current.turnSpeakers.get(event.turnId);
          if (speaker === undefined) return;
          if (speaker === "user") {
            current.lastUserSpeechAt = now;
            current.heard += event.text;
          }
          return yield* publish({
            type: "transcript",
            speaker,
            turnId: event.turnId,
            text: event.text,
            done: false,
          });
        }
        case "turn.done":
          current.turnSpeakers.delete(event.turnId);
          current.openTurns.delete(event.turnId);
          // The voice's reply opens its turn a few ms later; nothing may slip in between.
          if (event.speaker === "user") current.lastUserSpeechAt = now;
          // A voice turn cut off before its first word, a lone ".", did not answer anything.
          if (event.speaker === "voice" && stripLeadingMarks(event.text) !== "") current.heard = "";
          if (event.speaker === "voice" && current.interruption === null) {
            yield* settleSays("spoken", (other) => other.injected);
          }
          if (current.interruption?.turnId === event.turnId) {
            const { delegated } = current.interruption;
            current.interruption = null;
            const words = event.text.trim();
            if (!delegated && words.length > 0) {
              yield* steer(
                callId,
                current.id,
                `interruption-${event.turnId}`,
                words,
                voiceCallSendMode(followUpBehavior),
              );
              current.forwardedAt = now;
              current.heard = "";
            }
            // Only now: the agent must not carry on before the steer reached its thread.
            yield* settleSays("interrupted");
          }
          if (event.text.trim().length > 0) {
            recap = [...recap, { speaker: event.speaker, text: event.text.trim() }].slice(
              -RECAP_TURNS,
            );
            if (
              event.speaker === "voice" ||
              lastSteeredText === null ||
              !lastSteeredText.includes(stripLeadingMarks(event.text.trim()))
            ) {
              const role = event.speaker === "voice" ? "assistant" : "user";
              unsentTranscript = [...unsentTranscript, `${role}: ${event.text.trim()}`];
            }
          }
          return yield* publish({
            type: "transcript",
            speaker: event.speaker,
            turnId: event.turnId,
            text: event.text,
            done: true,
          });
        case "delegation.created": {
          if (
            current.forwardedAt !== null &&
            now - current.forwardedAt <= FORWARDED_DELEGATION_WINDOW_MS
          ) {
            return yield* sendAll(delegationAnswerEvents(event.itemId, alreadyForwardedAnswer));
          }
          if (current.interruption !== null) current.interruption.delegated = true;
          const { mode, text } = parseVoiceDelegation(event.text, followUpBehavior);
          yield* Effect.logInfo("voice call: delegation", {
            mode,
            followUpBehavior,
            marked: text !== event.text,
          });
          const whole = completeVoiceDelegation(text, current.heard);
          current.heard = "";
          return yield* steer(callId, current.id, event.itemId, whole, mode);
        }
        case "error":
          yield* Effect.logWarning("voice call: realtime error", event.code, event.message);
          if (event.code === "forbidden") yield* setCall({ error: event.message });
          return;
        default:
          return;
      }
    },
    (effect, _callId, _current, event) =>
      effect.pipe(
        Effect.andThen(flush),
        // Logs of this forked fiber reach no span, so the trace would not show the event otherwise.
        Effect.withSpan("VoiceCallService.handleEvent", {
          attributes: {
            "voiceCall.event": event.type,
            "voiceCall.speaker": "speaker" in event ? event.speaker : "",
            ...(event.type === "error"
              ? { "voiceCall.errorCode": event.code, "voiceCall.errorMessage": event.message }
              : {}),
          },
        }),
      ),
  );

  /** The sideband ended on its own: the session closed or the socket dropped. */
  const segmentEnded = (current: Segment, reason: string | null) =>
    lifecycle.withPermits(1)(
      Effect.logInfo("voice call: segment ended", { segmentId: current.id, reason }).pipe(
        Effect.andThen(() =>
          segment !== current
            ? Effect.void
            : endCall(
                reason === null || reason === "client_request"
                  ? null
                  : `The voice session ended (${reason}).`,
              ),
        ),
      ),
    );

  const connect: VoiceCallService["Service"]["connect"] = (input) =>
    lifecycle.withPermits(1)(
      Effect.gen(function* () {
        if ((subscriptions.get(input.clientId) ?? 0) === 0) {
          return yield* new VoiceCallError({ message: "Subscribe to the call before connecting." });
        }
        const { settings, auth } = yield* readAuth;
        if (auth._tag === "unavailable") {
          return yield* new VoiceCallError({
            message: auth.availability.message,
            reason: auth.availability.reason,
          });
        }
        // A retry, a takeover by another client and a fresh start all replace
        // the segment; only a call that already ended starts over.
        yield* closeSegment;
        const continuing =
          call !== null &&
          (call.state === "connecting" || call.state === "live" || call.state === "paused");
        if (!continuing) {
          // A new call starts empty: nothing of an ended one reaches it, not even owed answers.
          recap = [];
          unsentTranscript = [];
          lastSteeredText = null;
          pending = [];
          saidThreads.clear();
          delegations.clear();
        }
        const callId = continuing && call !== null ? call.callId : `vc-${yield* uuid}`;
        call = {
          callId,
          state: "connecting",
          ownerClientId: input.clientId,
          segmentId: null,
          targetThreadId: input.target,
          startedAt: continuing && call !== null ? call.startedAt : yield* nowIso,
          error: null,
        };
        yield* publishCall;

        // ponytail: read at connect, so a settings change applies from the next call or resume on.
        followUpBehavior = settings.voiceCallFollowUpBehavior ?? "steer";
        const targetTitle = input.target === null ? null : yield* threadTitle(input.target);
        const threadContext =
          input.target === null
            ? []
            : yield* projections
                .getThreadRecords(input.target, ["messages"], {
                  messageRoles: ["user", "assistant"],
                })
                .pipe(
                  Effect.map(({ messages }) => messages),
                  Effect.orElseSucceed(() => []),
                );
        const created = yield* realtime
          .createCall({
            auth: auth.auth,
            offerSdp: input.offerSdp,
            session: {
              instructions: frontEndInstructions({
                language: settings.voiceCallLanguage,
                persona: settings.voiceCallPersona,
                targetTitle,
                nowIso: yield* nowIso,
                followUpBehavior,
                threadContext,
                recap,
              }),
              voice: settings.voiceCallVoice ?? DEFAULT_VOICE_CALL_VOICE,
            },
          })
          .pipe(Effect.tapError((error) => setCall({ state: "error", error: error.message })));

        const scope = yield* Scope.make();
        const sideband = yield* realtime
          .openSideband({ auth: auth.auth, realtimeCallId: created.realtimeCallId })
          .pipe(
            Scope.provide(scope),
            Effect.tapError((error) =>
              Effect.andThen(
                Scope.close(scope, Exit.void),
                setCall({ state: "error", error: error.message }),
              ),
            ),
          );
        const current: Segment = {
          id: created.realtimeCallId,
          scope,
          sideband,
          turnSpeakers: new Map(),
          openTurns: new Map(),
          lastUserSpeechAt: Number.NEGATIVE_INFINITY,
          wakeAt: null,
          interruption: null,
          forwardedAt: null,
          heard: "",
        };
        segment = current;
        yield* usageTracker.segmentOpened;
        if (input.target !== null) yield* threadSpans.opened(input.target);
        yield* sideband.events.pipe(
          Stream.runForEach((event) =>
            event.type === "session.closed"
              ? segmentEnded(current, event.reason)
              : handleEvent(callId, current, event),
          ),
          Effect.andThen(segmentEnded(current, "disconnected")),
          Effect.forkIn(scope),
        );
        yield* setCall({ state: "live", segmentId: current.id });
        yield* Effect.logInfo("voice call: segment live", { callId, segmentId: current.id });
        // Whatever finished during a pause is told now, not at the next word.
        yield* flush;
        return { callId, segmentId: current.id, answerSdp: created.answerSdp };
      }),
    );

  const hangUp = lifecycle.withPermits(1)(endCall(null));

  const pause = lifecycle.withPermits(1)(
    Effect.suspend(() =>
      call?.state === "live"
        ? Effect.andThen(closeSegment, setCall({ state: "paused", segmentId: null }))
        : Effect.void,
    ),
  );

  const usage = Effect.gen(function* () {
    const planType = yield* settingsService.getSettings.pipe(
      Effect.flatMap(readVoiceCallPlanType),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => null),
    );
    const { reason, message } = yield* availability;
    return {
      ...(yield* usageTracker.summary(planType)),
      offered:
        message !== VOICE_CALLS_OFF &&
        reason !== "codex-not-logged-in" &&
        reason !== "codex-api-key",
    };
  });

  // Under `lifecycle`, so a move during a connect sees the segment instead of stale instructions.
  const setTarget = (target: ThreadId | null) =>
    lifecycle.withPermits(1)(
      Effect.gen(function* () {
        const moved = call !== null && call.targetThreadId !== target;
        if (moved && segment !== null) {
          yield* threadSpans.closed;
          if (target !== null) yield* threadSpans.opened(target);
        }
        yield* setCall({ targetThreadId: target });
        if (!moved || segment === null || target === null) return;
        const shell = yield* threads.getThreadShell(target).pipe(Effect.orElseSucceed(() => null));
        // A thread that cannot take work gets its answer at the delegation.
        if (shell !== null && shell.archivedAt === null) {
          yield* enqueue(null, targetMovedContext(shell.title));
        }
      }),
    );

  const subscribe = (clientId: string): Stream.Stream<VoiceCallEvent> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        subscriptions.set(clientId, (subscriptions.get(clientId) ?? 0) + 1);
        const snapshot: VoiceCallEvent = {
          type: "snapshot",
          availability: yield* availability,
          call,
          delegations: [...delegations.values()],
        };
        return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
      }),
    ).pipe(
      Stream.ensuring(
        Effect.suspend(() => {
          const remaining = (subscriptions.get(clientId) ?? 1) - 1;
          if (remaining > 0) {
            subscriptions.set(clientId, remaining);
            return Effect.void;
          }
          subscriptions.delete(clientId);
          // The owner's peer died with its last subscription: stop paying for the session.
          return call?.ownerClientId === clientId && carriesCall()
            ? lifecycle.withPermits(1)(endCall("The client carrying the call went away."))
            : Effect.void;
        }),
      ),
    );

  yield* Effect.addFinalizer(() => closeSegment);

  // Switching the feature off ends a running call.
  yield* (yield* settingsService.subscribeChanges).pipe(
    Stream.runForEach((next) =>
      next.voiceCallEnabled ? Effect.void : lifecycle.withPermits(1)(endCall(null)),
    ),
    Effect.forkScoped,
  );

  return VoiceCallService.of({
    subscribe,
    connect,
    setTarget,
    pause,
    hangUp,
    usage,
    threadSpans: threadSpans.forThread,
    answerDelegation,
    speak: (text) => Effect.suspend(() => (carriesCall() ? enqueue(null, text) : Effect.void)),
    say,
    takeSaid: (threadId) => Effect.sync(() => saidThreads.delete(threadId)),
    delegations: Effect.sync(() => [...delegations.values()]),
    targetThreadId: Effect.sync(() => call?.targetThreadId ?? null),
    live: Effect.sync(carriesCall),
    updateDelegation: (delegationId, patch) =>
      Effect.suspend(() => {
        const existing = delegations.get(delegationId);
        return existing === undefined ? Effect.void : recordDelegation({ ...existing, ...patch });
      }),
  });
});

export const layer = Layer.effect(VoiceCallService, make);

const withService = Effect.fn("VoiceCallService.withService")(function* <A, E>(
  use: (service: VoiceCallService["Service"]) => Effect.Effect<A, E>,
) {
  const service = yield* Effect.serviceOption(VoiceCallService);
  if (Option.isNone(service)) {
    return yield* new VoiceCallError({ message: "This server does not offer voice calls." });
  }
  return yield* use(service.value);
});

export const subscribeRpc = (input: { readonly clientId: string }) =>
  Stream.unwrap(withService((service) => Effect.succeed(service.subscribe(input.clientId))));

export const connectRpc = (input: VoiceCallConnectInput) =>
  withService((service) => service.connect(input)).pipe(
    Effect.tapError((error) => Effect.logWarning("voice call: connect failed", error.message)),
  );

export const setTargetRpc = (input: { readonly target: ThreadId | null }) =>
  withService((service) => service.setTarget(input.target)).pipe(Effect.as({}));

export const pauseRpc = () => withService((service) => service.pause).pipe(Effect.as({}));

export const hangUpRpc = () => withService((service) => service.hangUp).pipe(Effect.as({}));

export const usageRpc = () => withService((service) => service.usage);

export const threadSpansRpc = (threadId: ThreadId) =>
  withService((service) => service.threadSpans(threadId));
