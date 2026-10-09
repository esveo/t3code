import { CODE_NAVIGATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

/** Fork: the code navigation RPCs, as commands so hover lookups stay out of the query cache. */
export const codeNavigationEnvironment = {
  resolveDefinition: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:code-navigation:resolve-definition",
    tag: CODE_NAVIGATION_WS_METHODS.resolveDefinition,
  }),
  findReferences: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:code-navigation:find-references",
    tag: CODE_NAVIGATION_WS_METHODS.findReferences,
  }),
  readFile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:code-navigation:read-file",
    tag: CODE_NAVIGATION_WS_METHODS.readFile,
  }),
};
