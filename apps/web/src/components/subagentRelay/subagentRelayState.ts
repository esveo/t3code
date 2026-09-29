import { PROVIDER_SUBAGENT_CONTROL_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

export const subagentRelayEnvironment = {
  /** Who a relayed message goes to, and whether the subagent can be stopped. Fixed per thread. */
  target: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:subagent-relay:target",
    tag: PROVIDER_SUBAGENT_CONTROL_WS_METHODS.target,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:subagent-relay:stop",
    tag: PROVIDER_SUBAGENT_CONTROL_WS_METHODS.stop,
  }),
};
