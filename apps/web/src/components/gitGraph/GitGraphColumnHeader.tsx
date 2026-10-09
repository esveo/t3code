import {
  Children,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import {
  DEFAULT_GIT_GRAPH_COLUMN_WIDTHS,
  type GitGraphColumn,
  resizedGitGraphColumnWidth,
} from "./gitGraphColumns";

const KEYBOARD_STEP = 8;

/**
 * Column titles above the commit list, each with a drag handle. A drag only
 * previews widths and saves the final one on release.
 */
export function GitGraphColumnHeader({
  widths,
  onPreview,
  onResize,
}: {
  readonly widths: Readonly<Record<GitGraphColumn, number>>;
  readonly onPreview: (column: GitGraphColumn, width: number) => void;
  readonly onResize: (column: GitGraphColumn, width: number | null) => void;
}) {
  const handle = (column: GitGraphColumn, edge: "left" | "right") => (
    <ColumnResizeHandle
      column={column}
      edge={edge}
      width={widths[column]}
      onPreview={onPreview}
      onResize={onResize}
    />
  );
  return (
    <div className="sticky top-0 z-10 flex h-7 items-center border-b bg-background pr-6 pl-4 text-2xs text-muted-foreground select-none">
      <HeaderCell column="graph" className="pl-1">
        Graph
        {handle("graph", "right")}
      </HeaderCell>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="min-w-0 flex-1 truncate">Description</span>
        <HeaderCell column="author" className="hidden @xl/gitgraphrow:block">
          {handle("author", "left")}
          Author
        </HeaderCell>
        <HeaderCell column="date" className="text-right">
          {handle("date", "left")}
          Date
        </HeaderCell>
        <HeaderCell column="sha" className="hidden text-right @lg/gitgraphrow:block">
          {handle("sha", "left")}
          Commit
        </HeaderCell>
      </div>
    </div>
  );
}

/**
 * The cell itself must not clip: its handle hangs over the edge into the gap.
 * Only the title truncates.
 */
function HeaderCell({
  column,
  className,
  children,
}: {
  readonly column: GitGraphColumn;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div data-git-graph-col={column} className={cn("relative h-7 shrink-0 leading-7", className)}>
      {Children.map(children, (child) =>
        typeof child === "string" ? <span className="block truncate">{child}</span> : child,
      )}
    </div>
  );
}

function ColumnResizeHandle({
  column,
  edge,
  width,
  onPreview,
  onResize,
}: {
  readonly column: GitGraphColumn;
  readonly edge: "left" | "right";
  readonly width: number;
  readonly onPreview: (column: GitGraphColumn, width: number) => void;
  readonly onResize: (column: GitGraphColumn, width: number | null) => void;
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    let next = width;
    let frame = 0;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Pointer events outpace frames; relayout the list at most once per frame.
    const move = (moveEvent: PointerEvent) => {
      next = resizedGitGraphColumnWidth(column, width, moveEvent.clientX - startX);
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        onPreview(column, next);
      });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      cancelAnimationFrame(frame);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      if (next !== width) onResize(column, next);
      else onPreview(column, width);
    };
    // On the window, so the drag keeps going wherever the pointer wanders.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
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
        "absolute inset-y-0 z-10 w-3 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-border",
        "hover:after:bg-primary focus-visible:after:bg-primary",
        edge === "right" ? "-right-1.5" : "-left-3",
      )}
    />
  );
}
