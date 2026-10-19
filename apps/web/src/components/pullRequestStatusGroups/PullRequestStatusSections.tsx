/**
 * Fork: a thread's linked pull requests in collapsible sections by state, styled like the
 * threads overview's sections. The panel's virtualized list renders the items: a header per
 * section, then that section's lines while it is open.
 */
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import type { PullRequestListLine } from "@t3tools/shared/threadPullRequests";
import {
  groupPullRequestLinesByStatus,
  type PullRequestStatusGroup,
  type PullRequestStatusGroupId,
  SETTLED_PULL_REQUEST_GROUPS,
} from "./pullRequestStatusGroups.logic";

export type PullRequestStatusListItem =
  | { readonly kind: "header"; readonly group: PullRequestStatusGroup; readonly open: boolean }
  | { readonly kind: "line"; readonly line: PullRequestListLine };

/** The list items for `lines`, plus the toggle the section headers call. */
export function usePullRequestStatusListItems(lines: ReadonlyArray<PullRequestListLine>) {
  // Sections the user flipped away from their default (settled ones start closed).
  const [toggled, setToggled] = useState<ReadonlySet<PullRequestStatusGroupId>>(new Set());
  const items = useMemo(
    () =>
      groupPullRequestLinesByStatus(lines).flatMap((group): PullRequestStatusListItem[] => {
        const open = SETTLED_PULL_REQUEST_GROUPS.has(group.id) === toggled.has(group.id);
        return [
          { kind: "header", group, open },
          ...(open ? group.lines.map((line) => ({ kind: "line" as const, line })) : []),
        ];
      }),
    [lines, toggled],
  );
  const toggle = useCallback(
    (id: PullRequestStatusGroupId) =>
      setToggled((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  return { items, toggle };
}

export function PullRequestStatusHeader({
  group,
  open,
  onToggle,
}: {
  group: PullRequestStatusGroup;
  open: boolean;
  onToggle: (id: PullRequestStatusGroupId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(group.id)}
      aria-expanded={open}
      className="mt-1 mb-1 flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
      />
      {group.label}
      <span className="font-normal tabular-nums text-muted-foreground/80">
        {group.lines.length}
      </span>
    </button>
  );
}
