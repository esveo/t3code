import type { PullRequestDetail } from "@t3tools/contracts";

/**
 * What the pull request's diff is drawn from. Comments, labels and checks move `updatedAt` but
 * leave the diff alone; a push or a new base does not. Hosts that report no head commit fall back
 * to the change's size, which every push of substance moves.
 */
export function pullRequestDiffRevision(
  detail: Pick<
    PullRequestDetail,
    "baseBranch" | "headSha" | "additions" | "deletions" | "changedFiles"
  >,
): string {
  return detail.headSha !== undefined
    ? `${detail.baseBranch}@${detail.headSha}`
    : `${detail.baseBranch}:${detail.additions}:${detail.deletions}:${detail.changedFiles}`;
}

export interface ShownPullRequestDiff {
  readonly key: string;
  readonly revision: string;
}

/** True when the diff on screen was drawn from an older revision of the same pull request. */
export function isPullRequestDiffOutdated(
  shown: ShownPullRequestDiff | null,
  key: string,
  revision: string | null,
): boolean {
  return shown !== null && shown.key === key && revision !== null && shown.revision !== revision;
}
