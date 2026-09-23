import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import ChatView from "../ChatView";
import { SidebarInset, SidebarProvider } from "../ui/sidebar";
import { APP_DISPLAY_NAME } from "../../branding";
import {
  setActiveEnvironmentId,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";

/**
 * One thread, one window. The popout window renders this instead of the app
 * shell: no sidebar, no split grid, and no startup navigation that could pull
 * the window off the thread it was opened for.
 *
 * The window title carries the thread title, since the native frame is all
 * the chrome a popout has.
 */
export function ThreadPopoutView({ threadRef }: { threadRef: ScopedThreadRef }) {
  // This window is about one environment, so it is the active one here. The
  // app shell, which normally decides that, does not run in a popout.
  useEffect(() => {
    setActiveEnvironmentId(threadRef.environmentId);
  }, [threadRef.environmentId]);

  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const threadShell = useThreadShell(threadRef);
  const threadDetail = useThreadDetail(threadRef);
  const threadStatus = useThreadStatus(threadRef);
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

  const title = threadShell?.title ?? null;
  useEffect(() => {
    document.title = title ? `${title} — ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME;
  }, [title]);

  return (
    <SidebarProvider defaultOpen={false}>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
        {renderState === "missing" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
            This thread is no longer available. You can close this window.
          </div>
        ) : renderState === "ready" || threadShell !== null ? (
          <ChatView
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            threadSyncPhase={threadSyncPhase}
          />
        ) : null}
      </SidebarInset>
    </SidebarProvider>
  );
}
