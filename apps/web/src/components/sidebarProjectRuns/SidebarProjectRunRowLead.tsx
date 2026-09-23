import { NetworkIcon } from "lucide-react";
import type { SidebarThreadSummary } from "../../types";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import { MiddleTruncate } from "../ui/middle-truncate";
import { cn } from "~/lib/utils";

/**
 * Fork: what a row inside a project run puts where its project label used to
 * be. The run header carries the project now, so the slot goes to the branch —
 * the row's other stable identifier, and the one two-line cards otherwise drop
 * with their third line. Rows without a branch fall back to a spacer, which
 * keeps the status slot hard right.
 *
 * A coordinator in the "Cross-project" run shows that group instead, like
 * its children below it show their projects: its own project would say less.
 */
export function SidebarProjectRunRowLead(props: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
  crossProject?: boolean;
  recede?: boolean;
}) {
  if (props.crossProject) {
    return (
      <>
        <NetworkIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-secondary-label text-xs",
            props.recede ? "font-normal" : "font-medium",
          )}
        >
          Cross-project
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
