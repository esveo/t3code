/**
 * Fork: which coordinator each thread reports to, and a coordinator's
 * decisions, as the web app reads them (apps/web threadOrchestration and
 * threadInbox). A delegated child belongs to the thread that started it; the
 * server's coordinator links (adopted, launched-under and migrated threads)
 * override that. See `coordinatorThreadIdOf`.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  THREAD_COORDINATORS_WS_METHODS,
  THREAD_DECISIONS_WS_METHODS,
  type ThreadDecision,
  type ThreadId,
} from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";

export const coordinatorEnvironment = {
  links: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:thread-coordinators:links",
    tag: THREAD_COORDINATORS_WS_METHODS.subscribe,
    idleTtlMs: 30_000,
  }),
  decisions: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:thread-decisions:decisions",
    tag: THREAD_DECISIONS_WS_METHODS.subscribe,
    idleTtlMs: 30_000,
  }),
  act: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:thread-decisions:act",
    tag: THREAD_DECISIONS_WS_METHODS.act,
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
      const result = get(coordinatorEnvironment.links({ environmentId, input: {} }));
      const links = Option.getOrNull(AsyncResult.value(result))?.links ?? [];
      byEnvironment.set(
        environmentId,
        new Map(links.map((link) => [link.threadId, link.coordinatorThreadId])),
      );
    }
    return byEnvironment;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`esveo-coordinator-links:${key}`)),
);

export type CoordinatorOf = (thread: EnvironmentThreadShell) => ThreadId | null;

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
        .sort()
        .join(KEY_SEPARATOR),
    [serverConfigs, threads],
  );
  const overrides = useAtomValue(overridesByEnvironmentAtom(key));
  return useCallback(
    (thread) =>
      coordinatorThreadIdOf(thread.source, overrides.get(thread.environmentId) ?? NO_OVERRIDES),
    [overrides],
  );
}

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/**
 * The list without the threads of listed coordinators: those are reached from
 * their coordinator's Threads tab. A child whose coordinator is archived or
 * gone stays listed, so no thread becomes unreachable.
 */
export function useListedThreadShells(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const coordinatorOf = useCoordinatorOf(threads);
  return useMemo(() => {
    const listed = new Set(threads.map((thread) => threadKey(thread.environmentId, thread.id)));
    const visible = threads.filter((thread) => {
      const coordinatorId = coordinatorOf(thread);
      return coordinatorId === null || !listed.has(threadKey(thread.environmentId, coordinatorId));
    });
    return visible.length === threads.length ? threads : visible;
  }, [coordinatorOf, threads]);
}

/** The threads that report to this coordinator, archived ones left out. */
export function useCoordinatedThreads(
  coordinatorRef: ScopedThreadRef,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const coordinatorOf = useCoordinatorOf(threads);
  return useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.environmentId === coordinatorRef.environmentId &&
          thread.archivedAt === null &&
          thread.id !== coordinatorRef.threadId &&
          coordinatorOf(thread) === coordinatorRef.threadId,
      ),
    [coordinatorOf, coordinatorRef.environmentId, coordinatorRef.threadId, threads],
  );
}

const NO_DECISIONS: ReadonlyArray<ThreadDecision> = [];

/** The coordinator's decisions, while the user turned decisions on and its server keeps them. */
export function useCoordinatorDecisions(coordinatorRef: ScopedThreadRef): {
  readonly available: boolean;
  readonly decisions: ReadonlyArray<ThreadDecision>;
} {
  const config = useServerConfigs().get(coordinatorRef.environmentId);
  const available =
    config?.environment.capabilities.threadDecisions === true &&
    config.settings.enableThreadDecisions === true;
  const query = useEnvironmentQuery(
    available
      ? coordinatorEnvironment.decisions({
          environmentId: coordinatorRef.environmentId,
          input: { threadId: coordinatorRef.threadId },
        })
      : null,
  );
  return { available, decisions: query.data?.decisions ?? NO_DECISIONS };
}
