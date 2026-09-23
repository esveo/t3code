import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { countChildThreads, visibleChildThreads } from "./childThreads.logic";

const COLLAPSED_KEY = "sidebar-child-threads-collapsed";
const NO_COLLAPSED: readonly string[] = [];
const collapsedSchema = Schema.Array(Schema.String);

/**
 * Fork: the threads a coordinator started, under its row. A fold header counts
 * them and shows whether one waits on the user; folded, it still shows the
 * children that need attention and the open one, like a folded project run.
 */
export function SidebarChildThreads(props: {
  parentKey: string;
  children: ReadonlyArray<EnvironmentThreadShell>;
  openThreadKey: string | null;
  renderRow: (thread: EnvironmentThreadShell) => ReactNode;
}) {
  const [collapsedKeys, setCollapsedKeys] = useLocalStorage(
    COLLAPSED_KEY,
    NO_COLLAPSED,
    collapsedSchema,
  );
  const collapsed = collapsedKeys.includes(props.parentKey);
  const toggle = useCallback(
    () =>
      setCollapsedKeys((keys) =>
        keys.includes(props.parentKey)
          ? keys.filter((key) => key !== props.parentKey)
          : [...keys, props.parentKey],
      ),
    [props.parentKey, setCollapsedKeys],
  );
  const counts = useMemo(() => countChildThreads(props.children), [props.children]);
  const shown = visibleChildThreads({
    children: props.children,
    collapsed,
    openThreadKey: props.openThreadKey,
  });
  const label = `${counts.total} thread${counts.total === 1 ? "" : "s"}`;

  return (
    <li className="list-none" data-thread-selection-safe>
      <div className="relative ms-3 before:pointer-events-none before:absolute before:inset-y-1 before:left-[0.375rem] before:w-px before:bg-sidebar-border before:content-['']">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={[
            label,
            ...(counts.waiting > 0 ? [`${counts.waiting} waiting on you`] : []),
          ].join(", ")}
          className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md ps-3.5 pe-1.5 text-[11px] text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
          <span className="truncate">{label}</span>
          {/* Amber when a child waits on the user, blue while children only work. */}
          {counts.waiting > 0 || counts.working > 0 ? (
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                counts.waiting > 0
                  ? "bg-amber-500 dark:bg-amber-400"
                  : "bg-blue-500/70 dark:bg-blue-400/70",
              )}
            />
          ) : null}
        </button>
        {shown.length > 0 ? (
          <ul className="flex list-none flex-col gap-0.5 ps-3">{shown.map(props.renderRow)}</ul>
        ) : null}
      </div>
    </li>
  );
}
