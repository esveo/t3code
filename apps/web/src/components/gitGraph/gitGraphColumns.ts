import * as Schema from "effect/Schema";
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

/** The resizable columns of the commit list; the subject takes what is left. */
export type GitGraphColumn = "graph" | "author" | "date" | "sha";

export const GitGraphColumnWidths = Schema.Struct({
  // null follows the lane count, so the graph fits whatever the branches need.
  graph: Schema.NullOr(Schema.Number),
  author: Schema.Number,
  date: Schema.Number,
  sha: Schema.Number,
});
export type GitGraphColumnWidths = typeof GitGraphColumnWidths.Type;

export const DEFAULT_GIT_GRAPH_COLUMN_WIDTHS: GitGraphColumnWidths = {
  graph: null,
  author: 144,
  date: 48,
  sha: 64,
};

const MIN_WIDTH: Record<GitGraphColumn, number> = { graph: 16, author: 40, date: 32, sha: 40 };
const MAX_WIDTH = 640;
const STORAGE_KEY = "esveo:git-graph:column-widths";

/**
 * The width after dragging a column's handle by `deltaX` pixels. The graph's
 * handle sits on its right edge, the others' on their left edge (they hug the
 * right side of the row), so dragging left widens those.
 */
export function resizedGitGraphColumnWidth(
  column: GitGraphColumn,
  startWidth: number,
  deltaX: number,
): number {
  const width = column === "graph" ? startWidth + deltaX : startWidth - deltaX;
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH[column], width)));
}

const COLUMNS: ReadonlyArray<GitGraphColumn> = ["graph", "author", "date", "sha"];

/**
 * The commit list sizes its cells with one small stylesheet instead of inline
 * widths or inherited CSS variables: rewriting it restyles only the cells, which
 * keeps a drag at a fraction of a frame even with a thousand rows. Cells carry
 * `data-git-graph-col`, rows `data-git-graph-row`, the list `data-git-graph-list`.
 */
function gitGraphColumnRules(scope: string, widths: Readonly<Record<GitGraphColumn, number>>) {
  const list = `[data-git-graph-list="${scope}"]`;
  return [
    `${list} [data-git-graph-row] { padding-left: ${widths.graph}px; }`,
    ...COLUMNS.map(
      (column) => `${list} [data-git-graph-col="${column}"] { width: ${widths[column]}px; }`,
    ),
  ].join("\n");
}

/**
 * Keeps the list's stylesheet on `widths` and returns `preview`, which shows a
 * width mid-drag without a React render; the drag saves the final width itself.
 */
export function useGitGraphColumnStyle(
  listRef: RefObject<HTMLElement | null>,
  scope: string,
  widths: Readonly<Record<GitGraphColumn, number>>,
) {
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const widthsRef = useRef(widths);
  useLayoutEffect(() => {
    const ownerDocument = listRef.current?.ownerDocument ?? document;
    const style = ownerDocument.createElement("style");
    ownerDocument.head.append(style);
    styleRef.current = style;
    return () => {
      style.remove();
      styleRef.current = null;
    };
  }, [listRef]);
  const { graph, author, date, sha } = widths;
  useLayoutEffect(() => {
    widthsRef.current = { graph, author, date, sha };
    if (styleRef.current === null) return;
    styleRef.current.textContent = gitGraphColumnRules(scope, widthsRef.current);
  }, [scope, graph, author, date, sha]);
  return useCallback(
    (column: GitGraphColumn, width: number) => {
      if (styleRef.current === null) return;
      styleRef.current.textContent = gitGraphColumnRules(scope, {
        ...widthsRef.current,
        [column]: width,
      });
    },
    [scope],
  );
}

export function useGitGraphColumnWidths() {
  const [widths, setWidths] = useLocalStorage(
    STORAGE_KEY,
    DEFAULT_GIT_GRAPH_COLUMN_WIDTHS,
    GitGraphColumnWidths,
  );
  const setColumnWidth = (column: GitGraphColumn, width: number | null) =>
    setWidths((current) => ({ ...current, [column]: width }));
  return [widths, setColumnWidth] as const;
}
