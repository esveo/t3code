import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CHILD_THREAD_STATE_LABELS,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";
import { ChevronLeftIcon, SquareArrowOutUpRightIcon } from "lucide-react";

import ChatView from "~/components/ChatView";
import { ChatPaneContext } from "~/components/split/chatPane";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadDetail, useThreadShell, useThreadStatus } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { resolveThreadRouteRenderState } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { useOpenThread } from "./useOpenThread";

/** A pane id no split layout uses, so the embedded chat never owns window input. */
const EMBEDDED_PANE_ID = "thread-overview";

/**
 * Fork: a child thread opened inside its coordinator's Threads panel, as the
 * full chat (composer, approvals, questions) rather than a preview. It is a
 * passive pane: window-level shortcuts and paste stay with the coordinator.
 */
export function EmbeddedChildThread(props: { threadRef: ScopedThreadRef; onBack: () => void }) {
  const { threadRef } = props;
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const threadShell = useThreadShell(threadRef);
  const threadDetail = useThreadDetail(threadRef);
  const threadStatus = useThreadStatus(threadRef);
  const openThread = useOpenThread();
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: shell.data?.snapshot._tag === "Some",
    serverThreadShellExists: threadShell !== null,
    serverThreadDetailExists: threadDetail !== null,
    serverThreadDetailDeleted: threadStatus === "deleted",
    draftThreadExists: false,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: threadDetail !== null,
    shellExists: threadShell !== null,
    status: threadStatus,
  });
  const state = threadShell ? resolveChildThreadState(threadShell) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          onClick={props.onBack}
          aria-label="Back to threads"
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state ? CHILD_THREAD_DOT_CLASS[state] : "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {threadShell?.title ?? "Thread"}
        </span>
        {state ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {CHILD_THREAD_STATE_LABELS[state]}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                onClick={() => openThread(threadRef)}
                aria-label="Open as thread"
              />
            }
          >
            <SquareArrowOutUpRightIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open as thread</TooltipPopup>
        </Tooltip>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {renderState === "missing" ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            This thread is no longer available.
          </p>
        ) : renderState === "ready" || threadShell !== null ? (
          <ChatPaneContext.Provider value={EMBEDDED_PANE_ID}>
            <ChatView
              key={scopedThreadKey(threadRef)}
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              routeKind="server"
              threadSyncPhase={threadSyncPhase}
              reserveTitleBarControlInset={false}
              embedded
            />
          </ChatPaneContext.Provider>
        ) : null}
      </div>
    </div>
  );
}
