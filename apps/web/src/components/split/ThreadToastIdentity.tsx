import type { ReactNode } from "react";

import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

/**
 * Leading icon for thread notification toasts: the project's logo with the
 * notification's status icon pinned to its corner as a small badge, so the
 * toast says at a glance which project it came from and what happened.
 * Without a project it falls back to the status icon alone.
 */
export function ThreadToastIdentity(props: {
  readonly project: ProjectFaviconProject | null;
  readonly statusIcon: ReactNode;
}) {
  if (!props.project) return props.statusIcon;
  return (
    <span className="relative inline-flex size-4 shrink-0">
      <ProjectFavicon project={props.project} className="size-4" />
      <span className="absolute -right-1.5 -bottom-1.5 inline-flex size-3 items-center justify-center rounded-full bg-popover ring-2 ring-popover [&>svg]:size-3">
        {props.statusIcon}
      </span>
    </span>
  );
}
