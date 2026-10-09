import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { pullRequestRevisions } from "./codeNavigation.logic";
import { type CodeNavigationSurface, useCodeNavigation } from "./useCodeNavigation";

/**
 * Fork: code navigation for a pull request's Code tab. It runs in the checkout the pull request
 * was routed to (`detail.workspaceRoot`), which need not be the active thread's; commits the
 * clone lacks are fetched by the server.
 */
export function usePullRequestCodeNavigation({
  environmentId,
  reference,
  detail,
  commit,
  files,
  codeView,
}: Pick<CodeNavigationSurface, "files" | "codeView"> & {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetailView;
  readonly commit: string | null;
}) {
  const { repository, number } = reference;
  const { baseBranch, headSha, commits } = detail;
  const revisions = useMemo(
    () => pullRequestRevisions({ repository, number, baseBranch, headSha, commits, commit }),
    [baseBranch, commit, commits, headSha, number, repository],
  );
  return useCodeNavigation({
    environmentId,
    cwd: detail.workspaceRoot,
    revisions,
    files,
    codeView,
  });
}
