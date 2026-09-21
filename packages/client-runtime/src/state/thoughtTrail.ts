import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Recapping a turn's thinking. A command, not a query: it spends provider
 * quota, so it runs when somebody asks and the result is never refetched
 * behind their back.
 */
export function createThoughtTrailEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    summarize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thought-trail:summarize",
      tag: WS_METHODS.threadSummarizeThoughts,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnId]),
      },
    }),
  };
}
