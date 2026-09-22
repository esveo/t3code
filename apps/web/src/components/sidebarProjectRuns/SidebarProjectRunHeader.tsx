import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import type { SidebarProjectRunHeader as SidebarProjectRunHeaderInfo } from "./sidebarProjectRuns.logic";
import { cn } from "~/lib/utils";

/**
 * Fork: the label above one project's run of threads. It carries the identity
 * the rows below it no longer repeat — icon, name, how many threads — and
 * folds the run away.
 */
export const SidebarProjectRunHeader = memo(function SidebarProjectRunHeader(props: {
  header: SidebarProjectRunHeaderInfo;
  project: SidebarProjectSnapshot | null;
  onToggle: (projectKey: string) => void;
}) {
  const { header, project } = props;
  const label = project?.displayName ?? "Project";
  return (
    <li className="mx-0.5 list-none pt-2 first:pt-0.5" data-thread-selection-safe>
      <button
        type="button"
        onClick={() => props.onToggle(header.projectKey)}
        aria-expanded={!header.collapsed}
        aria-label={`${label}, ${header.threadCount} thread${header.threadCount === 1 ? "" : "s"}`}
        className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-sidebar-row-hover"
      >
        {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
        <span className="min-w-0 shrink truncate font-medium text-sidebar-foreground/75">
          {label}
        </span>
        {header.runningCount > 0 ? (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400"
          />
        ) : null}
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
        <span className="shrink-0 tabular-nums text-[10px] text-sidebar-muted-foreground/70">
          {header.threadCount}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground/60 transition-transform",
            header.collapsed && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
});
