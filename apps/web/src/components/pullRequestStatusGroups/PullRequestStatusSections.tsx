/**
 * Fork: a thread's linked pull requests in collapsible sections by state, styled like the
 * threads overview's sections. The caller renders each row.
 */
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import type { PullRequestListLine } from "../pullRequest/pullRequestListLines";
import {
  groupPullRequestLinesByStatus,
  type PullRequestStatusGroup,
  SETTLED_PULL_REQUEST_GROUPS,
} from "./pullRequestStatusGroups.logic";

function StatusSection({
  group,
  renderLine,
}: {
  group: PullRequestStatusGroup;
  renderLine: (line: PullRequestListLine) => ReactNode;
}) {
  const [open, setOpen] = useState(!SETTLED_PULL_REQUEST_GROUPS.has(group.id));
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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
      {open ? <div className="flex flex-col py-1">{group.lines.map(renderLine)}</div> : null}
    </section>
  );
}

export function PullRequestStatusSections({
  lines,
  renderLine,
}: {
  lines: ReadonlyArray<PullRequestListLine>;
  renderLine: (line: PullRequestListLine) => ReactNode;
}) {
  const groups = useMemo(() => groupPullRequestLinesByStatus(lines), [lines]);
  return (
    <div className="flex flex-col gap-2 p-1.5">
      {groups.map((group) => (
        <StatusSection key={group.id} group={group} renderLine={renderLine} />
      ))}
    </div>
  );
}
