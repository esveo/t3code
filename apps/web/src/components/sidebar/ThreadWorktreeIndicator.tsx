import { useGT } from "gt-react";
import { FolderGit2Icon } from "lucide-react";

import type { SidebarThreadSummary } from "../../types";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const gt = useGT();
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) return null;

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? gt("Worktree: {path} ({branch})", { path: displayPath, branch: thread.branch })
    : gt("Worktree: {path}", { path: displayPath });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3.5 shrink-0 text-icon-muted" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
