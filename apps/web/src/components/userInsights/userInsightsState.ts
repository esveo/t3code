import { USER_INSIGHTS_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

/** Fork: user insights. The environment's RPCs; all unary, the server owns the data. */
export const userInsightsEnvironment = {
  /** Status, profile, usage and folder, for the settings section. */
  read: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:user-insights:read",
    tag: USER_INSIGHTS_WS_METHODS.read,
    staleTimeMs: 10_000,
    idleTtlMs: 30_000,
  }),
  act: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:user-insights:act",
    tag: USER_INSIGHTS_WS_METHODS.act,
  }),
  /** Spends a Haiku call at most once per thread and turn. */
  suggest: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:user-insights:suggest",
    tag: USER_INSIGHTS_WS_METHODS.suggest,
  }),
};
