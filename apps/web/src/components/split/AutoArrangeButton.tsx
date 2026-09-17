import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { useSplitThreadStore } from "../../splitThreadStore";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  buildGridLayout,
  gridColumnCounts,
  recommendGrid,
  ROUTE_LEAF_ID,
  type GridSize,
} from "./splitLayout.logic";

const PICKER_COLUMNS = 8;
const PICKER_ROWS = 6;

let arrangeIdCounter = 0;
const nextArrangeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-a${++arrangeIdCounter}`;

/** The chat grid's size, or the window minus the sidebar when no grid is shown. */
function measureChatArea(): { width: number; height: number } {
  const grid = document.querySelector<HTMLElement>("[data-chat-grid]");
  if (grid) {
    const rect = grid.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  }
  const sidebarWidth =
    document.querySelector<HTMLElement>("[data-app-sidebar]")?.getBoundingClientRect().width ?? 0;
  return { width: window.innerWidth - sidebarWidth, height: window.innerHeight };
}

/**
 * Sidebar header button that arranges the pinned and active threads in a
 * grid. A table-style picker preselects the suggested grid; any other
 * columns × rows can be chosen before confirming.
 */
export function AutoArrangeButton({
  threads,
}: {
  /** Pinned then active threads, in sidebar order. */
  threads: readonly EnvironmentThreadShell[];
}) {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const setLayout = useSplitThreadStore((state) => state.setLayout);
  const setActiveLeaf = useSplitThreadStore((state) => state.setActiveLeaf);
  const [open, setOpen] = useState(false);
  const [area, setArea] = useState({ width: 1, height: 1 });
  const [selected, setSelected] = useState<GridSize>({ columns: 1, rows: 1 });
  const [hovered, setHovered] = useState<GridSize | null>(null);
  // Focus the confirm button, not the first grid cell, so opening the picker
  // keeps the suggested grid shown.
  const arrangeButtonRef = useRef<HTMLButtonElement>(null);

  const suggested = useMemo(
    () => recommendGrid(threads.length, area.width, area.height),
    [area, threads.length],
  );
  const shown = hovered ?? selected;
  const counts = gridColumnCounts(threads.length, shown);
  const placedCount = counts.reduce((sum, count) => sum + count, 0);

  const onOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const measured = measureChatArea();
      setArea(measured);
      setSelected(recommendGrid(threads.length, measured.width, measured.height));
      setHovered(null);
    }
    setOpen(nextOpen);
  };

  const arrange = () => {
    const routeThread = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
    const { layout, navigateTo } = buildGridLayout({
      threads: threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      routeThread,
      grid: selected,
      makeId: nextArrangeId,
    });
    setLayout(layout);
    setActiveLeaf(ROUTE_LEAF_ID);
    if (navigateTo) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(navigateTo),
      });
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<SidebarHeaderIconButton label="Auto arrange" disabled={threads.length === 0} />}
      >
        <LayoutGridIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="w-80" initialFocus={arrangeButtonRef}>
        <div className="flex flex-col gap-3">
          <div>
            <div className="font-medium text-sm">Auto arrange</div>
            <div className="text-muted-foreground text-xs">
              {threads.length} pinned and active {threads.length === 1 ? "session" : "sessions"}.
              The suggested grid is preselected; click another to change it.
            </div>
          </div>

          <div
            className="grid w-fit gap-1"
            style={{ gridTemplateColumns: `repeat(${PICKER_COLUMNS}, 1.25rem)` }}
            onPointerLeave={() => setHovered(null)}
            role="grid"
            aria-label="Grid size"
          >
            {Array.from({ length: PICKER_ROWS }, (_, row) =>
              Array.from({ length: PICKER_COLUMNS }, (_, column) => {
                const size = { columns: column + 1, rows: row + 1 };
                const inShown = column < shown.columns && row < shown.rows;
                const isSuggested = column + 1 === suggested.columns && row + 1 === suggested.rows;
                return (
                  <button
                    key={`${row}:${column}`}
                    type="button"
                    role="gridcell"
                    aria-label={`${size.columns} columns, ${size.rows} rows`}
                    aria-selected={selected.columns === size.columns && selected.rows === size.rows}
                    className={cn(
                      "size-5 rounded-[3px] border transition-colors",
                      inShown
                        ? "border-primary/70 bg-primary/25"
                        : "border-border bg-muted/40 hover:border-primary/40",
                      isSuggested && "ring-1 ring-primary ring-offset-1 ring-offset-popover",
                    )}
                    onPointerEnter={() => setHovered(size)}
                    onClick={() => setSelected(size)}
                  />
                );
              }),
            )}
          </div>

          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium">
              {shown.columns} × {shown.rows}
              {shown.columns === suggested.columns && shown.rows === suggested.rows
                ? " (suggested)"
                : ""}
            </span>
            <span
              className={cn(
                "text-muted-foreground",
                placedCount < threads.length && "text-warning",
              )}
            >
              {placedCount < threads.length
                ? `Arranges ${placedCount} of ${threads.length}`
                : `${placedCount} ${placedCount === 1 ? "pane" : "panes"}`}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button ref={arrangeButtonRef} size="sm" onClick={arrange} disabled={placedCount === 0}>
              Arrange
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
