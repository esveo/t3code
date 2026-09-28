import { PEERS_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const peersEnvironment = {
  /** Contacts, settings and the latest messages; the server sends all of it on every change. */
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:peers:snapshot",
    tag: PEERS_WS_METHODS.subscribe,
    idleTtlMs: 30_000,
  }),
  act: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:peers:act",
    tag: PEERS_WS_METHODS.act,
  }),
};
