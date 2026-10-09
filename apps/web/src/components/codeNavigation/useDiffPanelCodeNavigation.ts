import type { ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { diffPanelRevisions } from "./codeNavigation.logic";
import { type CodeNavigationSurface, useCodeNavigation } from "./useCodeNavigation";

/** Fork: code navigation for the thread diff panel, whose sides depend on what it compares. */
export function useDiffPanelCodeNavigation({
  turn,
  gitSource,
  ...surface
}: Omit<CodeNavigationSurface, "revisions"> & {
  /** The selected turn, or null for the git diffs. */
  readonly turn: {
    readonly threadId: ThreadId | null;
    readonly turnCount: number | undefined;
  } | null;
  readonly gitSource: ReviewDiffPreviewSource | undefined;
}) {
  const isTurn = turn !== null;
  const threadId = turn?.threadId ?? null;
  const turnCount = turn?.turnCount;
  const sourceKind = gitSource?.kind;
  const baseRef = gitSource?.baseRef ?? null;
  const revisions = useMemo(
    () =>
      isTurn
        ? threadId
          ? diffPanelRevisions({ kind: "turn", threadId, turnCount })
          : { base: null, head: null }
        : sourceKind === "working-tree"
          ? diffPanelRevisions({ kind: "unstaged" })
          : sourceKind === "branch-range"
            ? diffPanelRevisions({ kind: "branch", baseRef })
            : { base: null, head: null },
    [baseRef, isTurn, sourceKind, threadId, turnCount],
  );
  return useCodeNavigation({ ...surface, revisions });
}
