import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The commit graph is read on demand by its own view, so it refreshes when that
 * view mounts rather than on a timer: a repository only changes when the user
 * or an agent commits, and both land while the view is closed as often as not.
 */
export const gitGraphEnvironment = {
  commitGraph: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:git-graph:commits",
    tag: WS_METHODS.vcsListCommitGraph,
    staleTimeMs: 5_000,
  }),
};
