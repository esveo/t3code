import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import ChatView from "./ChatView";
import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { resolveThreadRouteRenderState, type ThreadRouteTarget } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import {
  ChatPaneContext,
  isSameThreadRef,
  useSplitThreadStore,
  type ChatPane,
} from "../splitThreadStore";
import { ThreadRouteView } from "./ThreadRouteView";

const ACTIVE_PANE_RING = "ring-1 ring-inset ring-primary/35";

/**
 * Renders the routed thread and, when one is chosen, a second thread beside
 * it. Both panes are siblings of the app sidebar so its inset styling applies
 * to each. The primary ThreadRouteView keeps its position in the tree, so
 * opening or closing the split never remounts the routed ChatView.
 */
export function SplitThreadLayout({ target }: { target: ThreadRouteTarget }) {
  const besideThreadRef = useSplitThreadStore((state) => state.besideThreadRef);
  const besideRatio = useSplitThreadStore((state) => state.besideRatio);
  const activePane = useSplitThreadStore((state) => state.activePane);
  const setActivePane = useSplitThreadStore((state) => state.setActivePane);
  const setBesideRatio = useSplitThreadStore((state) => state.setBesideRatio);
  const closeBeside = useSplitThreadStore((state) => state.closeBeside);
  const besidePaneRef = useRef<HTMLElement>(null);

  const primaryThreadRef = target.kind === "server" ? target.threadRef : null;
  const showBeside =
    besideThreadRef !== null && !isSameThreadRef(besideThreadRef, primaryThreadRef);

  // Opening the beside thread in the primary pane would show it twice.
  useEffect(() => {
    if (besideThreadRef !== null && isSameThreadRef(besideThreadRef, primaryThreadRef)) {
      closeBeside();
    }
  }, [besideThreadRef, closeBeside, primaryThreadRef]);

  // Whichever pane the user last pointed at or focused owns window-level input.
  useEffect(() => {
    if (!showBeside) return;
    const claim = (event: Event) => {
      const node = event.target instanceof Node ? event.target : null;
      if (!node) return;
      if (besidePaneRef.current?.contains(node)) {
        setActivePane("beside");
        return;
      }
      const element = node instanceof Element ? node : node.parentElement;
      if (element?.closest("[data-chat-pane='primary']")) setActivePane("primary");
    };
    window.addEventListener("pointerdown", claim, true);
    window.addEventListener("focusin", claim, true);
    return () => {
      window.removeEventListener("pointerdown", claim, true);
      window.removeEventListener("focusin", claim, true);
    };
  }, [setActivePane, showBeside]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pane = besidePaneRef.current;
      const container = pane?.parentElement;
      if (!pane || !container) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const paneRight = pane.getBoundingClientRect().right;
      // Measure against both panes, not the sidebar that shares the row.
      const chatAreaWidth =
        paneRight -
        (container.querySelector("[data-chat-pane='primary']")?.getBoundingClientRect().left ??
          container.getBoundingClientRect().left);
      const onMove = (moveEvent: PointerEvent) => {
        if (chatAreaWidth <= 0) return;
        setBesideRatio((paneRight - moveEvent.clientX) / chatAreaWidth);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [setBesideRatio],
  );

  return (
    <>
      <ThreadRouteView
        target={target}
        className={cn(showBeside && activePane === "primary" && ACTIVE_PANE_RING)}
      />
      {showBeside && besideThreadRef ? (
        <SidebarInset
          ref={besidePaneRef}
          data-chat-pane="beside"
          className={cn(
            "h-svh min-h-0 overflow-hidden border-l border-border overscroll-y-none bg-background text-foreground md:h-dvh",
            activePane === "beside" && ACTIVE_PANE_RING,
          )}
          // Both panes grow from a zero basis, so their grow factors split the chat
          // area (not the whole row, which includes the sidebar) by ratio.
          style={{ flex: `${besideRatio / (1 - besideRatio)} 1 0%` }}
        >
          <div
            aria-label="Resize split"
            role="separator"
            aria-orientation="vertical"
            className="absolute inset-y-0 -left-1.5 z-40 w-3 cursor-col-resize touch-none"
            onPointerDown={startResize}
          />
          <Button
            aria-label="Close split"
            title="Close split"
            size="icon-xs"
            variant="ghost"
            className="absolute bottom-2 left-2 z-40 opacity-60 hover:opacity-100"
            onClick={closeBeside}
          >
            <XIcon />
          </Button>
          <ChatPaneContext.Provider value={"beside" satisfies ChatPane}>
            <BesideThreadView threadRef={besideThreadRef} onMissing={closeBeside} />
          </ChatPaneContext.Provider>
        </SidebarInset>
      ) : null}
    </>
  );
}

function BesideThreadView({
  threadRef,
  onMissing,
}: {
  threadRef: ScopedThreadRef;
  onMissing: () => void;
}): ReactNode {
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

  useEffect(() => {
    if (renderState === "missing") onMissing();
  }, [onMissing, renderState]);

  if (renderState === "ready" || (renderState === "loading" && threadShell !== null)) {
    return (
      <ChatView
        key={`${threadRef.environmentId}:${threadRef.threadId}`}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        threadSyncPhase={threadSyncPhase}
        reserveTitleBarControlInset={false}
      />
    );
  }
  return null;
}
