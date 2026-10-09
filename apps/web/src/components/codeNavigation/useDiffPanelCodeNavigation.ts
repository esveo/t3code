import { useParams } from "@tanstack/react-router";
import type { ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useProject, useThreadShell } from "~/state/entities";
import { resolveThreadRouteRef } from "~/threadRoutes";

import { diffPanelRevisions } from "./codeNavigation.logic";
import { openInEditorTab } from "./EditorCodeNavigation";
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
  // Working-tree files of the thread's own checkout can be opened in the editor.
  const threadRef = useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) });
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const workspaceRoot = thread?.worktreePath ?? project?.workspaceRoot;
  const repositoryRoot = thread?.worktreePath ? undefined : project?.repositoryIdentity?.rootPath;
  const editable =
    threadRef !== null && workspaceRoot !== undefined && surface.cwd === workspaceRoot;
  const openInEditor = useCallback(
    (path: string, line: number, column: number) =>
      editable && threadRef && workspaceRoot
        ? openInEditorTab({ threadRef, cwd: workspaceRoot, repositoryRoot, path, line, column }) !==
          null
        : false,
    [editable, repositoryRoot, threadRef, workspaceRoot],
  );
  return useCodeNavigation({
    ...surface,
    revisions,
    openInEditor: editable ? openInEditor : undefined,
  });
}
