/**
 * Where the thread usage panel gets its numbers.
 *
 * The query is only ever built when the panel asks for it, so hovering the
 * context control never triggers a transcript scan.
 *
 * @module threadUsageState
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createThreadUsageAtomFamily } from "@t3tools/client-runtime/state/thread-usage";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "../state/query";

const threadUsageAtom = createThreadUsageAtomFamily(connectionAtomRuntime);

export function useThreadUsage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** False while the panel is closed or showing another tab. */
  readonly enabled: boolean;
}) {
  const { environmentId, threadId, enabled } = input;
  return useEnvironmentQuery(
    enabled && threadId !== null ? threadUsageAtom({ environmentId, input: { threadId } }) : null,
  );
}
