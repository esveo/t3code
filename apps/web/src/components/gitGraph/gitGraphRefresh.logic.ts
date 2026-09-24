import type { VcsStatusResult } from "@t3tools/contracts";

/**
 * When the commit graph is worth reading again. The graph is a one-off read,
 * but the git status beside it is a live subscription: a move of the branch,
 * the upstream counters or the set of changed files means commits or refs
 * probably moved too, so the status is the signal the graph follows.
 *
 * Line counts are left out on purpose: they change on every write while an
 * agent edits files, and the graph does not move with them. A commit shows up
 * as changed files leaving the working tree.
 */
export function gitGraphStatusKey(status: VcsStatusResult | null | undefined): string | null {
  if (!status) return null;
  return [
    status.refName ?? "",
    status.aheadCount,
    status.behindCount,
    status.hasWorkingTreeChanges ? 1 : 0,
    status.workingTree.files.map((file) => file.path).join("\n"),
  ].join("|");
}

/** A read this recent is not repeated; it keeps a status burst to one git log. */
export const GIT_GRAPH_FRESH_MS = 5_000;

/**
 * How long to wait before reading the graph again: null when the last read
 * already saw this status, otherwise the time left until that read goes stale.
 * A change inside the fresh window is deferred rather than dropped, so a
 * commit right after an edit still reaches the graph.
 */
export function gitGraphRefreshDelay(input: {
  readonly statusKey: string | null;
  readonly readKey: string | null;
  readonly dataUpdatedAt: number | null;
  readonly now: number;
}): number | null {
  if (input.statusKey === null || input.statusKey === input.readKey) return null;
  if (input.dataUpdatedAt === null) return 0;
  return Math.max(0, input.dataUpdatedAt + GIT_GRAPH_FRESH_MS - input.now);
}
