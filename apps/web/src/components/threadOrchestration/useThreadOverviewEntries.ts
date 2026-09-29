import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationV2Subagent, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useThreadShell, useThreadShells } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";
import { useCoordinatorOf } from "./coordinatorLinks";
import {
  childThreadsOf,
  type SubagentSnapshot,
  subagentThreadsOf,
  type ThreadOverviewEntry,
  threadOverviewEntries,
} from "./threadOverview.logic";

const NO_SUBAGENTS: ReadonlyArray<OrchestrationV2Subagent> = [];
const NO_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("fork-thread-overview:no-thread"),
);

/**
 * Fork: what the threads panel lists for a thread: the threads it coordinates
 * and the provider subagents its agent started. Subagent statuses come from
 * the thread's own projection, which is loaded while it is open; the selector
 * keeps streaming output from re-rendering the caller.
 */
export function useThreadOverviewEntries(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<ThreadOverviewEntry> {
  const threads = useThreadShells();
  const coordinatorOf = useCoordinatorOf(threads);
  // Only a thread the server knows: subscribing to a draft's details fetches
  // before the thread exists, and the chat view then reads that failed load.
  const serverThread = useThreadShell(threadRef) !== null;
  const subagents = useAtomValue(
    threadRef && serverThread ? environmentThreadDetails.threadAtom(threadRef) : NO_THREAD_ATOM,
    (thread) => thread?.projection.subagents ?? NO_SUBAGENTS,
  );
  const snapshots = useMemo(() => {
    const byThreadId = new Map<ThreadId, SubagentSnapshot>();
    // Records arrive in start order, so a resumed subagent's latest one wins.
    for (const subagent of subagents) {
      if (subagent.childThreadId === null) continue;
      byThreadId.set(subagent.childThreadId, {
        status: subagent.status,
        updatedAt: DateTime.formatIso(subagent.updatedAt),
      });
    }
    return byThreadId;
  }, [subagents]);
  return useMemo(() => {
    if (!threadRef) return [];
    const parent = { environmentId: threadRef.environmentId, id: threadRef.threadId };
    return threadOverviewEntries({
      children: childThreadsOf(threads, parent, coordinatorOf),
      subagentThreads: subagentThreadsOf(threads, parent, coordinatorOf),
      subagents: snapshots,
    });
  }, [coordinatorOf, snapshots, threadRef, threads]);
}
