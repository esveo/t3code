import type { ReviewDiffRange, VcsCommitGraphEntry } from "@t3tools/contracts";

/** The graph's id for the uncommitted changes row. Not hex, so it cannot collide with a sha. */
export const WORKTREE_ID = "worktree";

/**
 * A plain click selects one point; a modifier click adds a second point to
 * compare with, or removes a point that is already selected. A third point
 * replaces the second, so the first click stays the anchor.
 */
export function nextGitGraphSelection(
  current: ReadonlyArray<string>,
  id: string,
  additive: boolean,
): ReadonlyArray<string> {
  if (!additive) return current.length === 1 && current[0] === id ? [] : [id];
  if (current.includes(id)) return current.filter((candidate) => candidate !== id);
  return current.length === 0 ? [id] : [current[0]!, id];
}

/**
 * The diff a selection shows, older point first. `commits` is the graph's
 * newest-first row order with the worktree row, when shown, on top; that order
 * decides which of two points is the older one, whatever order they were
 * clicked in. Null when a point is no longer in the graph.
 */
export function gitGraphDiffRange(
  selection: ReadonlyArray<string>,
  commits: ReadonlyArray<VcsCommitGraphEntry>,
): ReviewDiffRange | null {
  const rows = selection.map((id) => commits.findIndex((commit) => commit.sha === id));
  if (rows.length === 0 || rows.some((row) => row < 0)) return null;
  const pointAt = (row: number) => commits[row]!;
  const idOf = (commit: VcsCommitGraphEntry) => (commit.sha === WORKTREE_ID ? null : commit.sha);

  if (rows.length === 1) {
    const commit = pointAt(rows[0]!);
    if (commit.sha === WORKTREE_ID) {
      const head = commit.parents[0];
      return head === undefined ? null : { base: head, head: null };
    }
    return { base: commit.parents[0] ?? null, head: commit.sha };
  }

  const [newer, older] = rows.toSorted((left, right) => left - right).map(pointAt);
  const base = idOf(older!);
  return base === null ? null : { base, head: idOf(newer!) };
}
