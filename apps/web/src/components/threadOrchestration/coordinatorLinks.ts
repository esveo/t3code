import { useAtomValue } from "@effect/atom-react";
import { THREAD_COORDINATORS_WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { useSidebarChildThreadsEnabled } from "./SidebarChildThreadsSetting";
import {
  type ChildThreadGroups,
  type CoordinatorOf,
  groupChildThreads,
  hiddenChildThreadGroups,
} from "./childThreads.logic";

/**
 * Fork: which coordinator each thread reports to. A delegated child belongs
 * to the thread that started it; the server's coordinator links (adopted,
 * moved and released threads) override that. See `coordinatorThreadIdOf`.
 */
export const coordinatorLinksEnvironment = {
  links: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:thread-coordinators:links",
    tag: THREAD_COORDINATORS_WS_METHODS.subscribe,
    idleTtlMs: 30_000,
  }),
  set: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:thread-coordinators:set",
    tag: THREAD_COORDINATORS_WS_METHODS.set,
  }),
};

type Overrides = ReadonlyMap<ThreadId, ThreadId | null>;
const NO_OVERRIDES: Overrides = new Map();
const KEY_SEPARATOR = "\u0000";

/** The links of the given environments, joined into one key so the atom stays shared. */
const overridesByEnvironmentAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyMap<EnvironmentId, Overrides> => {
    const byEnvironment = new Map<EnvironmentId, Overrides>();
    if (key === "") return byEnvironment;
    for (const environmentId of key.split(KEY_SEPARATOR) as EnvironmentId[]) {
      const result = get(coordinatorLinksEnvironment.links({ environmentId, input: {} }));
      const links = Option.getOrNull(AsyncResult.value(result))?.links ?? [];
      byEnvironment.set(
        environmentId,
        new Map(links.map((link) => [link.threadId, link.coordinatorThreadId])),
      );
    }
    return byEnvironment;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`fork-coordinator-links:${key}`)),
);

/** The coordinator lookup for threads of these environments. */
export function useCoordinatorOf(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId">>,
): CoordinatorOf {
  const serverConfigs = useServerConfigs();
  // Only servers that keep links are asked; others have no such method.
  const key = useMemo(
    () =>
      [...new Set(threads.map((thread) => thread.environmentId))]
        .filter(
          (environmentId) =>
            serverConfigs.get(environmentId)?.environment.capabilities.threadCoordinators === true,
        )
        .toSorted()
        .join(KEY_SEPARATOR),
    [serverConfigs, threads],
  );
  const overrides = useAtomValue(overridesByEnvironmentAtom(key));
  return useCallback(
    (thread: Pick<EnvironmentThreadShell, "environmentId" | "source">) =>
      coordinatorThreadIdOf(thread.source, overrides.get(thread.environmentId) ?? NO_OVERRIDES),
    [overrides],
  );
}

/** The coordinator the thread reports to, or null. */
export function useThreadCoordinatorId(threadRef: ScopedThreadRef | null): ThreadId | null {
  const thread = useThreadShell(threadRef);
  const threads = useMemo(() => (thread ? [thread] : []), [thread]);
  const coordinatorOf = useCoordinatorOf(threads);
  return thread ? coordinatorOf(thread) : null;
}

/** The sidebar's coordinator groups, following the coordinator links; hidden while the setting is off. */
export function useChildThreadGroups(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ChildThreadGroups {
  const coordinatorOf = useCoordinatorOf(threads);
  const enabled = useSidebarChildThreadsEnabled();
  return useMemo(
    () =>
      enabled
        ? groupChildThreads(threads, coordinatorOf)
        : hiddenChildThreadGroups(threads, coordinatorOf),
    [coordinatorOf, enabled, threads],
  );
}
