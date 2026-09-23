import type { ScopedThreadRef, ThreadDecision } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { waitingDecisionCount } from "./threadInbox.logic";
import { threadInboxEnvironment } from "./threadInboxState";

const EMPTY: ReadonlyArray<ThreadDecision> = [];

/**
 * Fork: a coordinator's decisions for the Inbox tab, whether the tab can open
 * for this thread, and how many decisions wait on the user. Any coordinator
 * can open it while orchestration and decisions are on (Settings → General)
 * and its server keeps decisions.
 */
export function useThreadInboxSurface(threadRef: ScopedThreadRef | null) {
  const thread = useThreadShell(threadRef);
  const environmentId = threadRef?.environmentId ?? ("" as ScopedThreadRef["environmentId"]);
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableThreadOrchestration && settings.enableThreadDecisions,
  );
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadDecisions === true;
  const available =
    threadRef !== null && thread !== null && supported && enabled && !thread.parentThreadId;
  const query = useEnvironmentQuery(
    available && threadRef
      ? threadInboxEnvironment.decisions({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const decisions = query.data?.decisions ?? EMPTY;
  const waitingCount = useMemo(() => waitingDecisionCount(decisions), [decisions]);
  const open = useCallback(() => {
    if (!threadRef || !available) return;
    useRightPanelStore.getState().open(threadRef, "thread-inbox");
  }, [available, threadRef]);
  return { available, decisions, loaded: query.isSuccess, error: query.error, waitingCount, open };
}
