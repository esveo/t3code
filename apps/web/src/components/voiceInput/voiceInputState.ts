import { VOICE_INPUT_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const voiceInputEnvironment = {
  /** Held while a dictation runs, so the model downloads and loads during the recording. */
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
