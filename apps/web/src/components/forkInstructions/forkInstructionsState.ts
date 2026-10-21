import { FORK_INSTRUCTIONS_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const forkInstructionsEnvironment = {
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-instructions:read",
    tag: FORK_INSTRUCTIONS_WS_METHODS.read,
  }),
  write: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-instructions:write",
    tag: FORK_INSTRUCTIONS_WS_METHODS.write,
  }),
};
