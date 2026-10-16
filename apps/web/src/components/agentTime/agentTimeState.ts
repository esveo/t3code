/**
 * Fork: where the Usage page's "Agent time" section gets its numbers.
 *
 * Each selected environment answers for its own threads; the section adds the
 * answers up. Read on demand like the usage summary: past days are cached on
 * the server, so a reopened page answers quickly.
 *
 * @module agentTimeState
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_TIME_WS_METHODS,
  type AgentTimeSummary,
  type AgentTimeSummaryInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";

const agentTimeSummaryAtom = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:agent-time",
  tag: AGENT_TIME_WS_METHODS.summary,
  staleTimeMs: 60_000,
});

export interface EnvironmentAgentTime {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly failed: boolean;
  readonly summary: AgentTimeSummary | null;
}

interface AgentTimeKey {
  readonly environmentIds: readonly EnvironmentId[];
  readonly input: AgentTimeSummaryInput;
}

const agentTimeByKeyAtom = Atom.family((key: string) =>
  Atom.make((get): readonly EnvironmentAgentTime[] => {
    const { environmentIds, input } = JSON.parse(key) as AgentTimeKey;
    return environmentIds.map((environmentId) => {
      const result = get(agentTimeSummaryAtom({ environmentId, input }));
      return {
        environmentId,
        isPending: result.waiting,
        failed: result._tag === "Failure",
        summary: Option.getOrNull(AsyncResult.value(result)),
      };
    });
  }).pipe(Atom.withLabel(`web-agent-time:${key}`)),
);

/** Every listed environment's agent time for one window and project filter. */
export function useAgentTime(
  environmentIds: readonly EnvironmentId[],
  input: AgentTimeSummaryInput,
): readonly EnvironmentAgentTime[] {
  const key = useMemo(
    () =>
      JSON.stringify({
        environmentIds: environmentIds.toSorted(),
        input: {
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          timeZone: input.timeZone,
          resolution: input.resolution,
          sinceTime: input.sinceTime,
          untilTime: input.untilTime,
          projectId: input.projectId,
        },
      } satisfies AgentTimeKey),
    [
      environmentIds,
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
      input.projectId,
    ],
  );
  return useAtomValue(agentTimeByKeyAtom(key));
}
