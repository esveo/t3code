import {
  VOICE_CALL_WS_METHODS,
  type VoiceCallAvailability,
  type VoiceCallDelegation,
  type VoiceCallEvent,
  type VoiceCallSpeaker,
  type VoiceCallStatus,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "~/connection/runtime";
import { randomUUID } from "~/lib/utils";
import { syncVoiceCallClock, voiceCallNow } from "./voiceCallLevels";

/** Identifies this tab to the server, which closes the call once its owner's tab is gone. */
export const voiceCallClientId = randomUUID();

/** "Claude Opus 5.5" -> "Opus 5.5", "GPT-6 Astra" -> "GPT-6": the lane label has little room. */
export const voiceCallModelLabel = (name: string) =>
  name.replace(/^claude\s+/i, "").replace(/^(gpt-?\s*\d+(?:\.\d+)?)\s.*$/i, "$1");

export interface VoiceCallView {
  readonly availability: VoiceCallAvailability | null;
  readonly call: VoiceCallStatus | null;
  readonly delegations: ReadonlyArray<VoiceCallDelegation>;
  readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
  /** This client's clock, like every time below: waves are sampled on it too. */
  readonly timelineStartedAt: number | null;
  readonly delegationSpans: Readonly<Record<string, VoiceCallSpan>>;
}

export interface VoiceCallSpan {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface VoiceCallTranscriptEntry extends VoiceCallSpan {
  readonly turnId: string;
  readonly speaker: VoiceCallSpeaker;
  readonly text: string;
}

const MAX_TRANSCRIPT_ENTRIES = 100;

export const EMPTY_VOICE_CALL_VIEW: VoiceCallView = {
  availability: null,
  call: null,
  delegations: [],
  transcript: [],
  timelineStartedAt: null,
  delegationSpans: {},
};

/** A session is up or coming up, so the diagram's time runs. */
export const isVoiceCallMoving = (call: VoiceCallStatus) =>
  call.state === "connecting" || call.state === "live";

const isVoiceCallOpen = (call: VoiceCallStatus) =>
  isVoiceCallMoving(call) || call.state === "paused";

/** The call stays on its thread until moved; the server lets only the owner or a paused call move. */
export const canBringVoiceCallHere = (
  call: VoiceCallStatus | null,
  clientId: string,
  threadId: ThreadId,
) =>
  call !== null &&
  call.targetThreadId !== threadId &&
  (call.state === "paused" || (isVoiceCallMoving(call) && call.ownerClientId === clientId));

/** Connect replaces the target, so resuming or taking over from another thread must resend it. */
export const voiceCallConnectTarget = (call: VoiceCallStatus | null, threadId: ThreadId | null) =>
  call !== null && isVoiceCallOpen(call) ? call.targetThreadId : threadId;

const delegationSpan = (
  existing: VoiceCallSpan | undefined,
  delegation: VoiceCallDelegation,
  now: number,
): VoiceCallSpan => ({
  startedAt: existing?.startedAt ?? now,
  endedAt: delegation.status === "open" ? null : (existing?.endedAt ?? now),
});

/** The server sends a snapshot, then deltas; it never resends the transcript, so this keeps it. */
export function reduceVoiceCallEvent(
  view: VoiceCallView,
  event: VoiceCallEvent,
  now = Date.now(),
): VoiceCallView {
  switch (event.type) {
    case "snapshot":
      return {
        availability: event.availability,
        call: event.call,
        delegations: event.delegations,
        transcript: view.transcript,
        // A call that ended before this subscription has nothing to show.
        timelineStartedAt:
          view.timelineStartedAt ??
          (event.call !== null && isVoiceCallOpen(event.call) ? now : null),
        delegationSpans: Object.fromEntries(
          event.delegations.map((delegation) => [
            delegation.id,
            delegationSpan(view.delegationSpans[delegation.id], delegation, now),
          ]),
        ),
      };
    case "call":
      // A retried segment keeps its call's startedAt, and with it the timeline.
      return event.call !== null && event.call.startedAt !== view.call?.startedAt
        ? { ...view, call: event.call, transcript: [], timelineStartedAt: now, delegationSpans: {} }
        : { ...view, call: event.call };
    case "delegation": {
      const others = view.delegations.filter((entry) => entry.id !== event.delegation.id);
      return {
        ...view,
        delegations: [...others, event.delegation],
        delegationSpans: {
          ...view.delegationSpans,
          [event.delegation.id]: delegationSpan(
            view.delegationSpans[event.delegation.id],
            event.delegation,
            now,
          ),
        },
      };
    }
    case "transcript": {
      const existing = view.transcript.find((entry) => entry.turnId === event.turnId);
      const entry: VoiceCallTranscriptEntry = {
        turnId: event.turnId,
        speaker: event.speaker,
        text: event.done ? event.text : (existing?.text ?? "") + event.text,
        startedAt: existing?.startedAt ?? now,
        endedAt: event.done ? now : null,
      };
      return {
        ...view,
        transcript: existing
          ? view.transcript.map((other) => (other === existing ? entry : other))
          : [...view.transcript, entry].slice(-MAX_TRANSCRIPT_ENTRIES),
      };
    }
  }
}

const logTranscript = (event: VoiceCallEvent) =>
  event.type === "transcript" && event.done
    ? Effect.logInfo(`[voice call] ${event.speaker}: ${event.text}`)
    : event.type === "delegation"
      ? Effect.logInfo(
          `[voice call] delegation ${event.delegation.status}: ${event.delegation.text}`,
        )
      : Effect.void;

export const voiceCallEnvironment = {
  view: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:voice-call:view",
    tag: VOICE_CALL_WS_METHODS.subscribe,
    // Long enough to survive switching threads; the server hangs up when it ends.
    idleTtlMs: 30_000,
    transform: (stream) =>
      stream.pipe(
        Stream.tap(logTranscript),
        Stream.scan(
          () => EMPTY_VOICE_CALL_VIEW,
          (view, event) => {
            if ((event.type === "snapshot" || event.type === "call") && event.call !== null) {
              syncVoiceCallClock(isVoiceCallMoving(event.call));
            }
            return reduceVoiceCallEvent(view, event, voiceCallNow());
          },
        ),
        Stream.drop(1),
      ),
  }),
  connect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice-call:connect",
    tag: VOICE_CALL_WS_METHODS.connect,
  }),
  setTarget: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice-call:set-target",
    tag: VOICE_CALL_WS_METHODS.setTarget,
  }),
  pause: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice-call:pause",
    tag: VOICE_CALL_WS_METHODS.pause,
  }),
  hangUp: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice-call:hang-up",
    tag: VOICE_CALL_WS_METHODS.hangUp,
  }),
  // Always stale, so opening the Usage page refetches it.
  usage: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:voice-call:usage",
    tag: VOICE_CALL_WS_METHODS.usage,
    staleTimeMs: 0,
  }),
  threadSpans: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:voice-call:thread-spans",
    tag: VOICE_CALL_WS_METHODS.threadSpans,
    staleTimeMs: 0,
  }),
};
