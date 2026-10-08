import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";

const NO_PROGRESS_ATOM = Atom.make(null).pipe(Atom.withLabel("subagent-progress:none"));

/**
 * Fork: what a running subagent reports it is doing, for the live row of its
 * own thread. Claude sends a line per tool it starts and a short summary
 * about every 30 seconds; the subagent's record in its parent thread keeps
 * the latest. Null for a thread that is no subagent, or before any line.
 */
export function useSubagentProgress(threadRef: ScopedThreadRef | null): string | null {
  const lineage = useThreadShell(threadRef)?.lineage;
  const parentRef =
    threadRef !== null &&
    lineage?.relationshipToParent === "subagent" &&
    lineage.parentThreadId !== null
      ? scopeThreadRef(threadRef.environmentId, lineage.parentThreadId)
      : null;
  return useAtomValue(
    parentRef === null ? NO_PROGRESS_ATOM : environmentThreadDetails.threadAtom(parentRef),
    (parent) => {
      const agent = parent?.projection.subagents.find(
        (subagent) => subagent.childThreadId === threadRef?.threadId,
      );
      const progress = agent?.status === "running" ? agent.progress?.trim() : undefined;
      return progress || null;
    },
  );
}
