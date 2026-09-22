/**
 * One thread's own token and cost totals.
 *
 * Read on demand rather than subscribed: the numbers come from a transcript
 * scan, and nobody watches them tick. A turn that lands while the panel is
 * open refreshes it through `refreshTrigger`.
 *
 * @module state/threadUsage
 */
import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createThreadUsageAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:thread-usage",
    tag: WS_METHODS.serverGetThreadUsage,
    // A cold scan costs seconds; reopening the panel must not pay it again.
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
  });
}
