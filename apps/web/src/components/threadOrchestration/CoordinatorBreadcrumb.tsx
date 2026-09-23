import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";
import { useMemo } from "react";

import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "~/components/WorkspaceBreadcrumb";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadShell } from "~/state/entities";
import { useOpenThread } from "./useOpenThread";

/**
 * Fork: in a thread a coordinator started, the coordinator sits in the header
 * breadcrumb before the title, the way back to where the work was planned.
 */
export function CoordinatorBreadcrumb(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const { environmentId, threadId } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const parentThreadId = useThreadShell(threadRef)?.parentThreadId ?? null;
  const parentRef = useMemo(
    () => (parentThreadId ? scopeThreadRef(environmentId, parentThreadId) : null),
    [environmentId, parentThreadId],
  );
  const parent = useThreadShell(parentRef);
  const openThread = useOpenThread();
  if (parentRef === null || parent === null) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open the coordinator, ${parent.title}`}
                onClick={() => openThread(parentRef)}
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <NetworkIcon aria-hidden className="size-3.5 shrink-0" />
            <WorkspaceBreadcrumbText className="max-w-40">{parent.title}</WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup side="top">Started by {parent.title}</TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
