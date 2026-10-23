/**
 * Fork: one voice call per environment. The client's WebRTC peer carries the
 * audio; this service creates each realtime session (a segment), holds its
 * sideband, hands the voice's delegations to the thread on screen and tells
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
  type VoiceCallDelegation,
  VoiceCallDisabledError,
  VoiceCallError,
  type VoiceCallEvent,
  type VoiceCallStatus,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
import { readVoiceCallAuth } from "./VoiceCallAuth.ts";
import {
  archivedTargetAnswer,
  BACKEND_HINT,
  dispatchFailedAnswer,
  frontEndInstructions,
  noTargetAnswer,
} from "./voiceCallPrompt.ts";

export const VOICE_CALL_CONTEXT_KIND = "voice-call";

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
    ) => Effect.Effect<VoiceCallConnectResult, VoiceCallError | VoiceCallDisabledError>;
    readonly setTarget: (target: ThreadId | null) => Effect.Effect<void>;
    readonly hangUp: Effect.Effect<void>;
    /** The delegation the voice is waiting on gets this text as its answer. */
    readonly answerDelegation: (delegationId: string, text: string) => Effect.Effect<void>;
    /** Something the voice should say without being asked. */
    readonly speak: (text: string) => Effect.Effect<void>;
    readonly delegations: Effect.Effect<ReadonlyArray<VoiceCallDelegation>>;
    readonly targetThreadId: Effect.Effect<ThreadId | null>;
    /** Every realtime event of the live segment, for the read-back. */
    readonly realtimeEvents: Stream.Stream<{
      readonly segmentId: string;
      readonly event: RealtimeEvent;
    }>;
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
}

const contextIdFor = (delegationId: string) =>
  `voice-${delegationId.replace(/[^a-z0-9_-]/gi, "").slice(-100)}`;

/** The steered message: a voice chip, then the voice's instruction. */
export const voiceDelegationMessage = (input: {
  readonly callId: string;
  readonly delegationId: string;
  readonly text: string;
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
          payload: { hint: BACKEND_HINT, callId: input.callId, delegationId: input.delegationId },
        },
      ],
    },
  };
};

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const threads = yield* ThreadManagementService;
  const realtime = yield* RealtimeCallClient;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lifecycle = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<VoiceCallEvent>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );
  const realtimeEvents = yield* Effect.acquireRelease(
    PubSub.unbounded<{ readonly segmentId: string; readonly event: RealtimeEvent }>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );

  let call: VoiceCallStatus | null = null;
  let segment: Segment | null = null;
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

  /** Closing the scope sends `session.close`; the realtime session stops billing. */
  const closeSegment = Effect.suspend(() => {
    const current = segment;
    segment = null;
    return current === null ? Effect.void : Scope.close(current.scope, Exit.void);
  });

  const endCall = (error: string | null) =>
    Effect.gen(function* () {
      yield* closeSegment;
      if (call !== null && (call.state === "connecting" || call.state === "live")) {
        yield* setCall({ state: error === null ? "ended" : "error", segmentId: null, error });
      }
    });

  const threadTitle = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.title ?? null),
      Effect.orElseSucceed(() => null),
    );

  const answerDelegation = (delegationId: string, text: string) =>
    sendAll(delegationAnswerEvents(delegationId, text));

  const steer = (callId: string, segmentId: string, delegationId: string, text: string) =>
    Effect.gen(function* () {
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
      const fail = (answer: string) =>
        Effect.andThen(
          recordDelegation({ ...base, status: "failed", answer }),
          answerDelegation(delegationId, answer),
        );
      if (targetThreadId === null) return yield* fail(noTargetAnswer);
      const shell = yield* threads
        .getThreadShell(targetThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return yield* fail(noTargetAnswer);
      if (shell.archivedAt !== null) return yield* fail(archivedTargetAnswer(shell.title));
      const message = voiceDelegationMessage({ callId, delegationId, text });
      const sent = yield* threads
        .sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`voice-call:${callId}:${delegationId}`),
          threadId: targetThreadId,
          messageId: MessageId.make(`voice-call-message:${callId}:${delegationId}`),
          text: message.text,
          context: message.context,
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.option);
      if (Option.isNone(sent)) return yield* fail(dispatchFailedAnswer(shell.title));
      yield* recordDelegation({
        ...base,
        messageId: sent.value.message.id,
        runId: sent.value.run.id,
      });
    });

  const handleEvent = (callId: string, current: Segment, event: RealtimeEvent) =>
    Effect.gen(function* () {
      yield* PubSub.publish(realtimeEvents, { segmentId: current.id, event });
      switch (event.type) {
        case "turn.created":
          current.turnSpeakers.set(event.turnId, event.speaker);
          return;
        case "turn.delta": {
          const speaker = current.turnSpeakers.get(event.turnId);
          if (speaker === undefined) return;
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
          return yield* publish({
            type: "transcript",
            speaker: event.speaker,
            turnId: event.turnId,
            text: event.text,
            done: true,
          });
        case "delegation.created":
          return yield* steer(callId, current.id, event.itemId, event.text);
        case "error":
          yield* Effect.logWarning("voice call: realtime error", event.code, event.message);
          if (event.code === "forbidden") yield* setCall({ error: event.message });
          return;
        default:
          return;
      }
    });

  /** The sideband ended on its own: the session closed or the socket dropped. */
  const segmentEnded = (current: Segment, reason: string | null) =>
    lifecycle.withPermits(1)(
      Effect.suspend(() =>
        segment !== current
          ? Effect.void
          : endCall(
              reason === null || reason === "client_request"
                ? null
                : `The voice session ended (${reason}).`,
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
          if (auth.availability.reason === "disabled") {
            return yield* new VoiceCallDisabledError({ message: auth.availability.message });
          }
          return yield* new VoiceCallError({
            message: auth.availability.message,
            reason: auth.availability.reason,
          });
        }
        // A retry, a takeover by another client and a fresh start all replace
        // the segment; only a call that already ended starts over.
        yield* closeSegment;
        const continuing = call !== null && (call.state === "connecting" || call.state === "live");
        if (!continuing) delegations.clear();
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

        const targetTitle = input.target === null ? null : yield* threadTitle(input.target);
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
        };
        segment = current;
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
        return { callId, segmentId: current.id, answerSdp: created.answerSdp };
      }),
    );

  const hangUp = lifecycle.withPermits(1)(endCall(null));

  const setTarget = (target: ThreadId | null) => setCall({ targetThreadId: target });

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
          return call?.ownerClientId === clientId && segment !== null
            ? lifecycle.withPermits(1)(endCall("The client carrying the call went away."))
            : Effect.void;
        }),
      ),
    );

  // A call must not outlive the flag: turning it off hangs up and tells every client.
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.enableVoiceCall),
    Stream.changes,
    Stream.runForEach((enabled) =>
      Effect.gen(function* () {
        if (!enabled) yield* hangUp;
        yield* publish({ type: "availability", availability: yield* availability });
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => closeSegment);

  return VoiceCallService.of({
    subscribe,
    connect,
    setTarget,
    hangUp,
    answerDelegation,
    speak: (text) => sendAll(sessionUpdateEvents(text)),
    delegations: Effect.sync(() => [...delegations.values()]),
    targetThreadId: Effect.sync(() => call?.targetThreadId ?? null),
    realtimeEvents: Stream.fromPubSub(realtimeEvents),
    updateDelegation: (delegationId, patch) =>
      Effect.suspend(() => {
        const existing = delegations.get(delegationId);
        return existing === undefined ? Effect.void : recordDelegation({ ...existing, ...patch });
      }),
  });
});

export const layer = Layer.effect(VoiceCallService, make);

const withService = <A, E>(use: (service: VoiceCallService["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(VoiceCallService);
    if (Option.isNone(service)) {
      return yield* new VoiceCallError({ message: "This server does not offer voice calls." });
    }
    return yield* use(service.value);
  });

export const subscribeRpc = (input: { readonly clientId: string }) =>
  Stream.unwrap(withService((service) => Effect.succeed(service.subscribe(input.clientId))));

export const connectRpc = (input: VoiceCallConnectInput) =>
  withService((service) => service.connect(input));

export const setTargetRpc = (input: { readonly target: ThreadId | null }) =>
  withService((service) => service.setTarget(input.target)).pipe(Effect.as({}));

export const hangUpRpc = () => withService((service) => service.hangUp).pipe(Effect.as({}));
