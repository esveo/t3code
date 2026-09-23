import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { memo } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SidebarProjectRunHeader as SidebarProjectRunHeaderInfo } from "./sidebarProjectRuns.logic";
import { cn } from "~/lib/utils";

/**
 * Fork: the label above one project's run of threads. It carries the identity
 * the rows below it no longer repeat — icon, name, how many threads — folds
 * the run away, and on hover offers a new thread in that project.
 */
export const SidebarProjectRunHeader = memo(function SidebarProjectRunHeader(props: {
  header: SidebarProjectRunHeaderInfo;
  project: SidebarProjectSnapshot | null;
  onToggle: (projectKey: string) => void;
  onNewThread: (project: SidebarProjectSnapshot) => void;
}) {
  const { header, project } = props;
  const label = project?.displayName ?? "Project";
  return (
    <li className="mx-0.5 list-none pt-2 first:pt-0.5" data-thread-selection-safe>
      {/* The toggle is an overlay rather than a wrapper so the new-thread
          button can sit in the row without nesting buttons. */}
      <div className="group/run-header relative flex h-7 items-center gap-2 rounded-md px-1.5 text-xs transition-colors hover:bg-sidebar-row-hover">
        <button
          type="button"
          onClick={() => props.onToggle(header.projectKey)}
          aria-expanded={!header.collapsed}
          aria-label={[
            label,
            `${header.threadCount} thread${header.threadCount === 1 ? "" : "s"}`,
            ...(header.attentionCount > 0 ? [`${header.attentionCount} waiting on you`] : []),
          ].join(", ")}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
        {project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null}
        <span className="min-w-0 shrink truncate font-medium text-sidebar-foreground/75">
          {label}
        </span>
        {/* Amber when the run waits on an answer, blue while it only works. */}
        {header.attentionCount > 0 || header.runningCount > 0 ? (
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              header.attentionCount > 0
                ? "bg-amber-500 dark:bg-amber-400"
                : "bg-blue-500/70 dark:bg-blue-400/70",
            )}
          />
        ) : null}
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
        {project ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`New thread in ${label}`}
                  onClick={() => props.onNewThread(project)}
                  className="pointer-events-none absolute right-0 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:relative focus-visible:opacity-100 group-hover/run-header:pointer-events-auto group-hover/run-header:relative group-hover/run-header:opacity-100"
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New thread in {label}</TooltipPopup>
          </Tooltip>
        ) : null}
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
      </div>
    </li>
  );
});
