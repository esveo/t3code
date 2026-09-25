import { VOICE_INPUT_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

/** Fork: the environment's local Whisper, which the web settings switch on. */
export const serverVoiceInputEnvironment = {
  /** Called with `download: false`: the phone offers dictation once the model is there. */
  prepare: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:voice-input:prepare",
    tag: VOICE_INPUT_WS_METHODS.prepare,
    idleTtlMs: 1_000,
  }),
  transcribe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice-input:transcribe",
    tag: VOICE_INPUT_WS_METHODS.transcribe,
  }),
};
