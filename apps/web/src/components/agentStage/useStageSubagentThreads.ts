import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails } from "../../state/threads";

type SubagentTimelines = ReadonlyMap<string, ReadonlyArray<OrchestrationV2ProjectedTurnItem>>;

const EMPTY: SubagentTimelines = new Map();
const SEPARATOR = "\n";

/**
 * The timelines of several subagent threads at once, keyed by the list of
 * them, so the same list reads the same atom on every render. Reading a
 * thread's detail atom subscribes to that thread, and the subscription ends
 * when the stage stops asking for it.
 */
const subagentTimelinesAtom = Atom.family((key: string) => {
  const [environmentId, ...threadIds] = key.split(SEPARATOR);
  let previous: SubagentTimelines = EMPTY;
  return Atom.make((get): SubagentTimelines => {
    const next = new Map<string, ReadonlyArray<OrchestrationV2ProjectedTurnItem>>();
    for (const threadId of threadIds) {
      const thread = get(
        environmentThreadDetails.threadAtom({
          environmentId: EnvironmentId.make(environmentId!),
          threadId: ThreadId.make(threadId),
        }),
      );
      if (thread !== null) next.set(threadId, thread.projection.visibleTurnItems);
    }
    const unchanged =
      next.size === previous.size &&
      [...next].every(([threadId, rows]) => previous.get(threadId) === rows);
    if (!unchanged) previous = next;
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`agent-stage-subagent-threads:${key}`));
});

const NO_THREADS_ATOM = Atom.make(EMPTY).pipe(Atom.withLabel("agent-stage-subagent-threads:none"));

/**
 * Subagents run in threads of their own, so following one tool to tool means
 * loading its thread. The stage asks only for the subagents it shows.
 */
export function useStageSubagentThreads(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): SubagentTimelines {
  return useAtomValue(
    threadIds.length === 0
      ? NO_THREADS_ATOM
      : subagentTimelinesAtom([environmentId, ...threadIds].join(SEPARATOR)),
  );
}
