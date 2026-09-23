import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useHasChildThreads, useThreadOverviewSurface } from "./useThreadOverviewSurface";

/**
 * Fork: opens the thread overview from the header of a coordinator that has
 * started threads, with the count of those waiting on the user.
 */
export function ThreadOverviewHeaderButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const overview = useThreadOverviewSurface(threadRef);
  const hasChildren = useHasChildThreads(threadRef);
  if (!hasChildren) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            onClick={overview.open}
            aria-label={
              overview.waitingCount > 0
                ? `Threads, ${overview.waitingCount} waiting on you`
                : "Threads"
            }
          />
        }
      >
        <NetworkIcon aria-hidden />
        <span className="hidden @3xl/header-actions:inline">Threads</span>
        {overview.waitingCount > 0 ? (
          <span className="rounded-full bg-amber-500/15 px-1.5 text-xs tabular-nums text-amber-600 dark:text-amber-400">
            {overview.waitingCount}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Threads started from here</TooltipPopup>
    </Tooltip>
  );
}
