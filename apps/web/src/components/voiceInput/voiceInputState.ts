import { VOICE_INPUT_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const voiceInputEnvironment = {
  /** Downloads the model; held by the setting while it is on, and by a dictation in case the model is missing. */
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
