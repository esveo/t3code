import { THREAD_DECISIONS_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const threadInboxEnvironment = {
  /** A coordinator's decisions; the server sends the full list on every change. */
  decisions: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:thread-inbox:decisions",
    tag: THREAD_DECISIONS_WS_METHODS.subscribe,
    idleTtlMs: 30_000,
  }),
  act: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:thread-inbox:act",
    tag: THREAD_DECISIONS_WS_METHODS.act,
  }),
};
