import { NetworkIcon } from "lucide-react";
import { T } from "gt-react";
import type { SidebarThreadSummary } from "../../types";
import { ThreadWorktreeIndicator } from "../sidebar/ThreadWorktreeIndicator";
import { MiddleTruncate } from "../ui/middle-truncate";
import { cn } from "~/lib/utils";

/** The run header owns the project label, so rows use this slot for their distinguishing branch. */
export function SidebarProjectRunRowLead(props: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
  crossProject?: boolean;
  recede?: boolean;
}) {
  if (props.crossProject) {
    return (
      <>
        <SidebarCoordinatorIcon />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-secondary-label text-xs",
            props.recede ? "font-normal" : "font-medium",
          )}
        >
          <T>Cross-project</T>
        </span>
      </>
    );
  }
  const branch = props.thread.branch;
  if (!branch) return <span className="flex-1" />;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground/45">
      <ThreadWorktreeIndicator thread={props.thread} />
      <MiddleTruncate value={branch} showTitle={false} className="min-w-0 flex-1" />
    </span>
  );
}

/** Fork: the coordinator's stand-in for a project favicon. */
export function SidebarCoordinatorIcon() {
  return <NetworkIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />;
}
