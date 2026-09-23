import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useServerConfigs, useThreadShell } from "~/state/entities";

/**
 * Whether the thread's agents open as chats: the server must stream
 * transcripts (older servers reject the method), and only Claude files a
 * transcript per subagent.
 */
export function useSubagentChatSupport(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): boolean {
  const threadRef = useMemo(
    () =>
      environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, threadId) : null,
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  const config = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  if (thread === null || config === undefined) return false;
  if (config.environment.capabilities.subagentChat !== true) return false;
  const instanceId = thread.modelSelection.instanceId;
  return config.providers.some(
    (provider) => provider.instanceId === instanceId && provider.driver === "claudeAgent",
  );
}
