import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CHILD_THREAD_STATE_LABELS,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";
import { useMemo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { useOpenThread } from "./useOpenThread";

/**
 * Fork: a thread mentioned in a message (`[title](t3-thread:ID)`), as a chip
 * with the thread's live state that opens it. The link text is the fallback
 * when the thread is gone.
 */
export function ThreadLinkChip(props: {
  environmentId: EnvironmentId;
  threadId: string;
  label: string;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId as ThreadId),
    [props.environmentId, props.threadId],
  );
  const thread = useThreadShell(threadRef);
  const openThread = useOpenThread();
  const state = thread ? resolveChildThreadState(thread) : null;
  const title = thread?.title ?? props.label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={thread === null}
            onClick={() => openThread(threadRef)}
            className="mx-0.5 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-info/10 px-1.5 align-baseline text-[0.95em] text-info-foreground transition-colors hover:bg-info/20 disabled:cursor-default disabled:opacity-60"
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state ? CHILD_THREAD_DOT_CLASS[state] : "bg-muted-foreground/40",
          )}
        />
        <span className="truncate">{title}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {state ? `${title} · ${CHILD_THREAD_STATE_LABELS[state]}` : "This thread is no longer here"}
      </TooltipPopup>
    </Tooltip>
  );
}
