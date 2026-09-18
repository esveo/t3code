import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GripVerticalIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import ChatView from "./ChatView";
import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import {
  buildThreadRouteParams,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { setPendingPaneDrop, useSplitThreadStore, type SplitDragSource } from "../splitThreadStore";
import {
  closeLeaf,
  computeLayout,
  dropExistingLeaf,
  dropNewThread,
  dropZoneRect,
  equalizeBranch,
  findLeaf,
  findThreadLeaf,
  removeLeaf,
  resizeBranch,
  resolveDropZone,
  ROUTE_LEAF_ID,
  sameThread,
  type DropZone,
  type LayoutDivider,
  type Rect,
  type SplitLeaf,
} from "./split/splitLayout.logic";
import { ChatPaneContext } from "./split/chatPane";
import { isPopoutWindow, openThreadPopout } from "./split/threadPopout";
import { ThreadRouteView } from "./ThreadRouteView";

const DRAG_START_DISTANCE = 4;

let paneIdCounter = 0;
const nextPaneId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++paneIdCounter}`;

const percent = (value: number) => `${value * 100}%`;
const rectStyle = (rect: Rect) => ({
  left: percent(rect.left),
  top: percent(rect.top),
  width: percent(rect.width),
  height: percent(rect.height),
});

interface DropTarget {
  readonly leafId: string;
  readonly zone: DropZone;
}

/**
 * Chat panes arranged like VS Code editor groups. Drag a thread from the
 * sidebar, or a pane by its header, onto a pane: the outer edges split it,
 * the centre replaces (thread) or swaps (pane).
 *
 * Every pane is an absolutely positioned sibling keyed by its id, so changing
 * the layout moves panes without remounting their ChatViews.
 */
export function SplitThreadLayout({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const layout = useSplitThreadStore((state) => state.layout);
  const activeLeafId = useSplitThreadStore((state) => state.activeLeafId);
  const drag = useSplitThreadStore((state) => state.drag);
  const setLayout = useSplitThreadStore((state) => state.setLayout);
  const setActiveLeaf = useSplitThreadStore((state) => state.setActiveLeaf);
  const setDrag = useSplitThreadStore((state) => state.setDrag);
  const gridRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const routeThreadRef = target.kind === "server" ? target.threadRef : null;
  const isSplit = layout.kind === "split";
  const { panes, dividers } = useMemo(() => computeLayout(layout), [layout]);
  // Stable DOM order: moving keyed nodes would reset their scroll positions.
  const orderedPanes = useMemo(
    () => [...panes].sort((left, right) => left.leaf.id.localeCompare(right.leaf.id)),
    [panes],
  );

  const navigateToThread = useCallback(
    (thread: ScopedThreadRef) =>
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(thread) }),
    [navigate],
  );

  // A thread opened in the route pane is not shown a second time elsewhere.
  useEffect(() => {
    if (!routeThreadRef) return;
    const duplicate = findThreadLeaf(layout, routeThreadRef);
    if (duplicate) setLayout(removeLeaf(layout, duplicate.id));
  }, [layout, routeThreadRef, setLayout]);

  useEffect(() => {
    if (!findLeaf(layout, activeLeafId)) setActiveLeaf(ROUTE_LEAF_ID);
  }, [activeLeafId, layout, setActiveLeaf]);

  // Navigating is a deliberate move to the route pane, so it takes over input.
  // Nothing else may claim it: a pane the user is not in must never pull focus
  // out of the one they are typing in.
  const routeKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
  useEffect(() => {
    if (routeKey) setActiveLeaf(ROUTE_LEAF_ID);
  }, [routeKey, setActiveLeaf]);

  // Whichever pane the user last pointed at or focused owns window-level input.
  useEffect(() => {
    if (!isSplit) return;
    const claim = (event: Event) => {
      const element =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const pane = element?.closest<HTMLElement>("[data-chat-pane]");
      if (pane?.dataset.chatPane) setActiveLeaf(pane.dataset.chatPane);
    };
    window.addEventListener("pointerdown", claim, true);
    window.addEventListener("focusin", claim, true);
    return () => {
      window.removeEventListener("pointerdown", claim, true);
      window.removeEventListener("focusin", claim, true);
    };
  }, [isSplit, setActiveLeaf]);

  const closePane = useCallback(
    (leafId: string) => {
      const result = closeLeaf(useSplitThreadStore.getState().layout, leafId);
      setLayout(result.layout);
      if (result.navigateTo) navigateToThread(result.navigateTo);
    },
    [navigateToThread, setLayout],
  );

  // A pane leaves the grid for a window of its own. The pane only closes once
  // the window is really open, so a blocked popup leaves the layout untouched.
  const popOutPane = useCallback(
    (leafId: string, threadRef: ScopedThreadRef) => {
      if (!openThreadPopout(threadRef)) return;
      closePane(leafId);
    },
    [closePane],
  );

  const drop = useCallback(
    (source: SplitDragSource, { leafId, zone }: DropTarget) => {
      const current = useSplitThreadStore.getState().layout;
      let sourceLeafId: string | null = source.kind === "leaf" ? source.leafId : null;
      if (source.kind === "thread") {
        if (routeThreadRef && sameThread(source.thread, routeThreadRef)) {
          sourceLeafId = ROUTE_LEAF_ID;
        } else {
          sourceLeafId = findThreadLeaf(current, source.thread)?.id ?? null;
        }
      }
      if (sourceLeafId) {
        setLayout(
          dropExistingLeaf(current, {
            sourceLeafId,
            targetLeafId: leafId,
            zone,
            newBranchId: nextPaneId("split"),
          }),
        );
        setActiveLeaf(sourceLeafId);
        return;
      }
      if (source.kind !== "thread") return;
      if (zone === "center" && leafId === ROUTE_LEAF_ID) {
        navigateToThread(source.thread);
        setActiveLeaf(ROUTE_LEAF_ID);
        return;
      }
      const newLeafId = nextPaneId("pane");
      setLayout(
        dropNewThread(current, {
          targetLeafId: leafId,
          zone,
          thread: source.thread,
          newLeafId,
          newBranchId: nextPaneId("split"),
        }),
      );
      setActiveLeaf(zone === "center" ? leafId : newLeafId);
    },
    [navigateToThread, routeThreadRef, setActiveLeaf, setLayout],
  );

  // While something is dragged, track the pane and zone under the pointer.
  useEffect(() => {
    if (!drag) return;
    let currentTarget: DropTarget | null = null;
    const resolveTarget = (x: number, y: number): DropTarget | null => {
      const grid = gridRef.current;
      if (!grid) return null;
      for (const element of grid.querySelectorAll<HTMLElement>("[data-chat-pane]")) {
        const rect = element.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const leafId = element.dataset.chatPane;
        if (!leafId) return null;
        const zone = resolveDropZone((x - rect.left) / rect.width, (y - rect.top) / rect.height);
        return { leafId, zone };
      }
      return null;
    };
    const onMove = (event: PointerEvent) => {
      const target = resolveTarget(event.clientX, event.clientY);
      currentTarget = target;
      setDropTarget(target);
      setPointer({ x: event.clientX, y: event.clientY });
      // A sidebar drag ends inside dnd-kit, whose release handler may run before
      // ours; hand it the drop so it can skip its own reorder either way.
      if (drag.kind === "thread") setPendingPaneDrop(target ? () => drop(drag, target) : null);
    };
    const onUp = () => {
      if (drag.kind === "leaf") {
        if (currentTarget) drop(drag, currentTarget);
        setDrag(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      currentTarget = null;
      setDropTarget(null);
      setPendingPaneDrop(null);
      if (drag.kind === "leaf") setDrag(null);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      setDropTarget(null);
      setPointer(null);
    };
  }, [drag, drop, setDrag]);

  const startResize = useCallback(
    (divider: LayoutDivider, event: React.PointerEvent<HTMLDivElement>) => {
      const grid = gridRef.current;
      if (!grid) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const gridRect = grid.getBoundingClientRect();
      const onMove = (moveEvent: PointerEvent) => {
        const { branchRect } = divider;
        const fraction =
          divider.direction === "row"
            ? ((moveEvent.clientX - gridRect.left) / gridRect.width - branchRect.left) /
              branchRect.width
            : ((moveEvent.clientY - gridRect.top) / gridRect.height - branchRect.top) /
              branchRect.height;
        const current = useSplitThreadStore.getState().layout;
        setLayout(resizeBranch(current, divider.branchId, divider.index, fraction));
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
    [setLayout],
  );

  const dropHighlight = useMemo(() => {
    if (!dropTarget) return null;
    const pane = panes.find((candidate) => candidate.leaf.id === dropTarget.leafId);
    if (!pane) return null;
    const zone = dropZoneRect(dropTarget.zone);
    return {
      left: pane.rect.left + zone.left * pane.rect.width,
      top: pane.rect.top + zone.top * pane.rect.height,
      width: zone.width * pane.rect.width,
      height: zone.height * pane.rect.height,
    };
  }, [dropTarget, panes]);

  // A popout window is one thread's window: it never grows a grid, whatever
  // the shared layout says, and whatever it navigates to.
  if (isPopoutWindow()) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ThreadRouteView target={target} bare />
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div ref={gridRef} data-chat-grid className="relative min-h-0 min-w-0 flex-1">
        {orderedPanes.map(({ leaf, rect }) => (
          <div
            key={leaf.id}
            data-chat-pane={leaf.id}
            className={cn(
              "absolute flex min-h-0 min-w-0 flex-col overflow-hidden",
              isSplit && activeLeafId === leaf.id && "ring-1 ring-inset ring-primary/35",
            )}
            style={rectStyle(rect)}
          >
            {isSplit ? (
              <PaneHeader
                leaf={leaf}
                routeThreadRef={routeThreadRef}
                onClose={() => closePane(leaf.id)}
                onPopOut={(threadRef) => popOutPane(leaf.id, threadRef)}
                onDragStart={(title) => setDrag({ kind: "leaf", leafId: leaf.id, title })}
              />
            ) : null}
            {/* Layout containment makes the chat's fixed-position header controls
                anchor to this pane instead of the window. */}
            <div
              className={cn("relative flex min-h-0 flex-1 flex-col", isSplit && "[contain:layout]")}
            >
              <ChatPaneContext.Provider value={leaf.id}>
                {leaf.thread === "route" ? (
                  <ThreadRouteView
                    target={target}
                    bare
                    reserveTitleBarControlInset={rect.left === 0 && rect.top === 0}
                  />
                ) : (
                  <PaneThreadView
                    threadRef={leaf.thread}
                    reserveTitleBarControlInset={rect.left === 0 && rect.top === 0}
                    onMissing={() => closePane(leaf.id)}
                  />
                )}
              </ChatPaneContext.Provider>
            </div>
          </div>
        ))}
        {dividers.map((divider) => (
          <div
            key={`${divider.branchId}:${divider.index}`}
            role="separator"
            aria-orientation={divider.direction === "row" ? "vertical" : "horizontal"}
            aria-label="Resize panes"
            className={cn(
              "absolute z-30 touch-none",
              "after:absolute after:bg-border after:content-['']",
              divider.direction === "row"
                ? "-ml-1.5 w-3 cursor-col-resize after:inset-y-0 after:left-1/2 after:w-px"
                : "-mt-1.5 h-3 cursor-row-resize after:inset-x-0 after:top-1/2 after:h-px",
            )}
            style={
              divider.direction === "row"
                ? {
                    left: percent(divider.rect.left),
                    top: percent(divider.rect.top),
                    height: percent(divider.rect.height),
                  }
                : {
                    left: percent(divider.rect.left),
                    top: percent(divider.rect.top),
                    width: percent(divider.rect.width),
                  }
            }
            onPointerDown={(event) => startResize(divider, event)}
            onDoubleClick={() =>
              setLayout(equalizeBranch(useSplitThreadStore.getState().layout, divider.branchId))
            }
          />
        ))}
        {dropHighlight ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-40 rounded-md border-2 border-primary/60 bg-primary/15 transition-all duration-100"
            style={rectStyle(dropHighlight)}
          />
        ) : null}
      </div>
      {drag && pointer ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-md"
          style={{ left: pointer.x + 12, top: pointer.y + 12 }}
        >
          {drag.title}
        </div>
      ) : null}
    </SidebarInset>
  );
}

function PaneHeader({
  leaf,
  routeThreadRef,
  onClose,
  onPopOut,
  onDragStart,
}: {
  leaf: SplitLeaf;
  routeThreadRef: ScopedThreadRef | null;
  onClose: () => void;
  onPopOut: (threadRef: ScopedThreadRef) => void;
  onDragStart: (title: string) => void;
}) {
  const threadRef = leaf.thread === "route" ? routeThreadRef : leaf.thread;
  const shell = useThreadShell(threadRef);
  const title = shell?.title ?? "New thread";

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      if (
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_START_DISTANCE
      ) {
        return;
      }
      cleanup();
      onDragStart(title);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", cleanup, true);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", cleanup, true);
  };

  return (
    <div
      className="flex h-7 shrink-0 cursor-grab items-center gap-1 border-b border-border bg-muted/30 pr-1 pl-1.5 text-muted-foreground text-xs select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
    >
      <GripVerticalIcon className="size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {threadRef ? (
        <Button
          aria-label="Open pane in a new window"
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          onClick={() => onPopOut(threadRef)}
        >
          <SquareArrowOutUpRightIcon />
        </Button>
      ) : null}
      <Button
        aria-label="Close pane"
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function PaneThreadView({
  threadRef,
  reserveTitleBarControlInset,
  onMissing,
}: {
  threadRef: ScopedThreadRef;
  reserveTitleBarControlInset: boolean;
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

  const handleMissing = useEffectEvent(onMissing);
  useEffect(() => {
    if (renderState === "missing") handleMissing();
  }, [renderState]);

  if (renderState === "ready" || (renderState === "loading" && threadShell !== null)) {
    return (
      <ChatView
        key={`${threadRef.environmentId}:${threadRef.threadId}`}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        threadSyncPhase={threadSyncPhase}
        reserveTitleBarControlInset={reserveTitleBarControlInset}
      />
    );
  }
  return null;
}
