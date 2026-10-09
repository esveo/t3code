import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

import { cn } from "~/lib/utils";

import {
  DEFAULT_GIT_GRAPH_COLUMN_WIDTHS,
  type GitGraphColumn,
  gitGraphColumnVar,
  resizedGitGraphColumnWidth,
} from "./gitGraphColumns";

const KEYBOARD_STEP = 8;

/**
 * Column titles above the commit list, each with a drag handle. While dragging
 * only the CSS variable on `containerRef` changes; the width is saved on release.
 */
export function GitGraphColumnHeader({
  widths,
  containerRef,
  onResize,
}: {
  readonly widths: Readonly<Record<GitGraphColumn, number>>;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly onResize: (column: GitGraphColumn, width: number | null) => void;
}) {
  const handle = (column: GitGraphColumn, edge: "left" | "right") => (
    <ColumnResizeHandle
      column={column}
      edge={edge}
      width={widths[column]}
      containerRef={containerRef}
      onResize={onResize}
    />
  );
  return (
    <div className="sticky top-0 z-10 flex h-6 items-center border-b bg-background pr-6 pl-4 text-2xs text-muted-foreground select-none">
      <span
        className="relative shrink-0 truncate pl-1"
        style={{ width: `var(${gitGraphColumnVar("graph")})` }}
      >
        Graph
        {handle("graph", "right")}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="min-w-0 flex-1 truncate">Description</span>
        <span
          className="relative hidden shrink-0 truncate @xl/gitgraphrow:block"
          style={{ width: `var(${gitGraphColumnVar("author")})` }}
        >
          Author
          {handle("author", "left")}
        </span>
        <span
          className="relative shrink-0 text-right"
          style={{ width: `var(${gitGraphColumnVar("date")})` }}
        >
          Date
          {handle("date", "left")}
        </span>
        <span
          className="relative hidden shrink-0 text-right @lg/gitgraphrow:block"
          style={{ width: `var(${gitGraphColumnVar("sha")})` }}
        >
          Commit
          {handle("sha", "left")}
        </span>
      </div>
    </div>
  );
}

function ColumnResizeHandle({
  column,
  edge,
  width,
  containerRef,
  onResize,
}: {
  readonly column: GitGraphColumn;
  readonly edge: "left" | "right";
  readonly width: number;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly onResize: (column: GitGraphColumn, width: number | null) => void;
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let next = width;
    target.setPointerCapture(pointerId);
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    const move = (moveEvent: PointerEvent) => {
      next = resizedGitGraphColumnWidth(column, width, moveEvent.clientX - startX);
      containerRef.current?.style.setProperty(gitGraphColumnVar(column), `${next}px`);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      document.body.style.cursor = previousCursor;
      if (next !== width) onResize(column, next);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const step =
      event.key === "ArrowLeft" ? -KEYBOARD_STEP : event.key === "ArrowRight" ? KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onResize(column, resizedGitGraphColumnWidth(column, width, step));
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${column} column (double-click resets)`}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(column, DEFAULT_GIT_GRAPH_COLUMN_WIDTHS[column])}
      className={cn(
        "absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-border",
        "hover:after:bg-primary focus-visible:after:bg-primary",
        edge === "right" ? "-right-1" : "-left-2.5",
      )}
    />
  );
}
