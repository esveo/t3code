import {
  VOICE_CALL_WS_METHODS,
  type VoiceCallAvailability,
  type VoiceCallDelegation,
  type VoiceCallEvent,
  type VoiceCallStatus,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "~/connection/runtime";
import { randomUUID } from "~/lib/utils";

/** Identifies this tab to the server, which closes the call once its owner's tab is gone. */
export const voiceCallClientId = randomUUID();

export interface VoiceCallView {
  readonly availability: VoiceCallAvailability | null;
  readonly call: VoiceCallStatus | null;
  readonly delegations: ReadonlyArray<VoiceCallDelegation>;
}

const EMPTY_VIEW: VoiceCallView = { availability: null, call: null, delegations: [] };

/** The server sends a snapshot, then deltas; transcripts only go to the console for now. */
export function reduceVoiceCallEvent(view: VoiceCallView, event: VoiceCallEvent): VoiceCallView {
  switch (event.type) {
    case "snapshot":
      return { availability: event.availability, call: event.call, delegations: event.delegations };
    case "availability":
      return { ...view, availability: event.availability };
    case "call":
      return { ...view, call: event.call };
    case "delegation": {
      const others = view.delegations.filter((entry) => entry.id !== event.delegation.id);
      return { ...view, delegations: [...others, event.delegation] };
    }
    case "transcript":
      return view;
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
        Stream.scan(() => EMPTY_VIEW, reduceVoiceCallEvent),
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
  hangUp: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice-call:hang-up",
    tag: VOICE_CALL_WS_METHODS.hangUp,
  }),
};
