import type { VcsStatusResult } from "@t3tools/contracts";

/**
 * When the commit graph is worth reading again. The graph is a one-off read,
 * but the git status beside it is a live subscription: any move of the
 * branch, the upstream counters or the working tree means commits or refs
 * moved too, so the status is the signal the graph follows.
 */
export function gitGraphStatusKey(status: VcsStatusResult | null | undefined): string | null {
  if (!status) return null;
  return [
    status.refName ?? "",
    status.aheadCount,
    status.behindCount,
    status.hasWorkingTreeChanges ? 1 : 0,
    status.workingTree.insertions,
    status.workingTree.deletions,
  ].join("|");
}

/** A read this recent is not repeated; it keeps a status burst to one git log. */
export const GIT_GRAPH_FRESH_MS = 5_000;

export function gitGraphIsFresh(dataUpdatedAt: number | null, now: number): boolean {
  return dataUpdatedAt !== null && now - dataUpdatedAt < GIT_GRAPH_FRESH_MS;
}
