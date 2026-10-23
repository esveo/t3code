/**
 * Fork: voice call. A realtime voice model (GPT-Live on the user's ChatGPT
 * login) talks with the user, hands real work to the thread open on screen and
 * reads the result back. The client owns the microphone, the speaker and the
 * WebRTC peer; the server creates the call, holds the event sideband and is
 * the only one that reads or writes realtime events.
 * See docs/internals/voice-call.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, MessageId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_CALL_WS_METHODS = {
  subscribe: "voiceCall.subscribe",
  connect: "voiceCall.connect",
  setTarget: "voiceCall.setTarget",
  hangUp: "voiceCall.hangUp",
} as const;

/**
 * The voices the realtime v3 session accepts. Any other name ends the session
 * with "Voice session access denied.", so settings only offer this list.
 */
export const VOICE_CALL_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
] as const;
export const VoiceCallVoice = Schema.Literals(VOICE_CALL_VOICES);
export type VoiceCallVoice = typeof VoiceCallVoice.Type;
export const DEFAULT_VOICE_CALL_VOICE: VoiceCallVoice = "miko";

/** `auto` answers in the user's language; `de` speaks German from the first sentence. */
export const VoiceCallLanguage = Schema.Literals(["auto", "de"]);
export type VoiceCallLanguage = typeof VoiceCallLanguage.Type;

export const VOICE_CALL_PERSONA_MAX_LENGTH = 2_000;
export const VoiceCallPersona = Schema.String.check(
  Schema.isMaxLength(VOICE_CALL_PERSONA_MAX_LENGTH),
);

/** Why a call cannot start, so the UI can say so. */
export const VoiceCallUnavailableReason = Schema.Literals([
  "disabled",
  "codex-not-logged-in",
  "codex-api-key",
  "codex-login-expired",
]);
export type VoiceCallUnavailableReason = typeof VoiceCallUnavailableReason.Type;

export const VoiceCallAvailability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(VoiceCallUnavailableReason),
  message: Schema.NullOr(Schema.String),
});
export type VoiceCallAvailability = typeof VoiceCallAvailability.Type;

/**
 * `connecting`: a segment is being created. `live`: a realtime session is open.
 * `ended`: hung up. `error`: the last segment failed and no retry is running.
 */
export const VoiceCallState = Schema.Literals(["connecting", "live", "ended", "error"]);
export type VoiceCallState = typeof VoiceCallState.Type;

export const VoiceCallStatus = Schema.Struct({
  callId: TrimmedNonEmptyString,
  state: VoiceCallState,
  /** The client whose peer carries the audio; any other client shows the call as taken over. */
  ownerClientId: Schema.String,
  /** The realtime session now carrying the call, if any. */
  segmentId: Schema.NullOr(Schema.String),
  /** The thread delegations go to; null when no thread is on screen. */
  targetThreadId: Schema.NullOr(ThreadId),
  startedAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
});
export type VoiceCallStatus = typeof VoiceCallStatus.Type;

/**
 * `open`: sent to the thread, waiting for its run. `answered`: the result was
 * read back. `superseded`: a later request steered the same run and gets the
 * answer instead. `failed`: it never reached the thread, or the run failed.
 */
export const VoiceCallDelegationStatus = Schema.Literals([
  "open",
  "answered",
  "superseded",
  "failed",
]);
export type VoiceCallDelegationStatus = typeof VoiceCallDelegationStatus.Type;

/** One request the voice handed to a thread. */
export const VoiceCallDelegation = Schema.Struct({
  /** The realtime delegation item id. */
  id: TrimmedNonEmptyString,
  segmentId: Schema.String,
  text: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  runId: Schema.NullOr(RunId),
  status: VoiceCallDelegationStatus,
  /** What was read back, as sent to the voice. */
  answer: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type VoiceCallDelegation = typeof VoiceCallDelegation.Type;

export const VoiceCallSpeaker = Schema.Literals(["user", "voice"]);
export type VoiceCallSpeaker = typeof VoiceCallSpeaker.Type;

/** The first item of a subscription is a snapshot; deltas follow, so a long call never resends its transcript. */
export const VoiceCallEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    availability: VoiceCallAvailability,
    call: Schema.NullOr(VoiceCallStatus),
    delegations: Schema.Array(VoiceCallDelegation),
  }),
  Schema.Struct({ type: Schema.Literal("availability"), availability: VoiceCallAvailability }),
  Schema.Struct({ type: Schema.Literal("call"), call: Schema.NullOr(VoiceCallStatus) }),
  /** A transcript delta while a turn runs, then its full text once with `done`. */
  Schema.Struct({
    type: Schema.Literal("transcript"),
    speaker: VoiceCallSpeaker,
    turnId: Schema.String,
    text: Schema.String,
    done: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("delegation"), delegation: VoiceCallDelegation }),
]);
export type VoiceCallEvent = typeof VoiceCallEvent.Type;

export const VoiceCallSubscribeInput = Schema.Struct({
  /** Random per client tab; ties the peer to the subscription that keeps it alive. */
  clientId: TrimmedNonEmptyString,
});
export type VoiceCallSubscribeInput = typeof VoiceCallSubscribeInput.Type;

export const VoiceCallConnectInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  offerSdp: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  target: Schema.NullOr(ThreadId),
  /** The segment whose peer never connected; the server closes it and starts a new one. */
  retryOf: Schema.optionalKey(Schema.String),
});
export type VoiceCallConnectInput = typeof VoiceCallConnectInput.Type;

export const VoiceCallConnectResult = Schema.Struct({
  callId: TrimmedNonEmptyString,
  segmentId: TrimmedNonEmptyString,
  answerSdp: Schema.String,
});
export type VoiceCallConnectResult = typeof VoiceCallConnectResult.Type;

export const VoiceCallSetTargetInput = Schema.Struct({
  target: Schema.NullOr(ThreadId),
});
export type VoiceCallSetTargetInput = typeof VoiceCallSetTargetInput.Type;

export class VoiceCallDisabledError extends Schema.TaggedError<VoiceCallDisabledError>()(
  "VoiceCallDisabledError",
  { message: Schema.String },
) {}

export class VoiceCallError extends Schema.TaggedError<VoiceCallError>()("VoiceCallError", {
  message: Schema.String,
  reason: Schema.optionalKey(VoiceCallUnavailableReason),
}) {}

const VoiceCallRpcError = Schema.Union([
  VoiceCallDisabledError,
  VoiceCallError,
  EnvironmentAuthorizationError,
]);

export const WsVoiceCallSubscribeRpc = Rpc.make(VOICE_CALL_WS_METHODS.subscribe, {
  payload: VoiceCallSubscribeInput,
  success: VoiceCallEvent,
  error: VoiceCallRpcError,
  stream: true,
});

export const WsVoiceCallConnectRpc = Rpc.make(VOICE_CALL_WS_METHODS.connect, {
  payload: VoiceCallConnectInput,
  success: VoiceCallConnectResult,
  error: VoiceCallRpcError,
});

export const WsVoiceCallSetTargetRpc = Rpc.make(VOICE_CALL_WS_METHODS.setTarget, {
  payload: VoiceCallSetTargetInput,
  success: Schema.Struct({}),
  error: VoiceCallRpcError,
});

export const WsVoiceCallHangUpRpc = Rpc.make(VOICE_CALL_WS_METHODS.hangUp, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: VoiceCallRpcError,
});
