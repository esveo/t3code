import * as Schema from "effect/Schema";

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

/** Rows read their widths from these variables, so a drag repaints without re-rendering. */
export const gitGraphColumnVar = (column: GitGraphColumn) => `--esveo-git-graph-${column}`;

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
