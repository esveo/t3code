import { FORK_NOTES_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const forkNotesEnvironment = {
  /** One scope's notes; the server sends the full list on every change. */
  notes: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:fork-notes:notes",
    tag: FORK_NOTES_WS_METHODS.subscribe,
    idleTtlMs: 30_000,
  }),
  act: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-notes:act",
    tag: FORK_NOTES_WS_METHODS.act,
  }),
};
