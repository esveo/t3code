import type { ReactNode } from "react";

import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

/**
 * Leading avatar for thread notification toasts: the project's logo, spanning
 * both text lines, with the notification's status icon pinned to its corner as
 * a small badge, so the toast says at a glance which project it came from and
 * what happened.
 * Without a project it falls back to the status icon alone.
 */
export function ThreadToastIdentity(props: {
  readonly project: ProjectFaviconProject | null;
  readonly statusIcon: ReactNode;
}) {
  if (!props.project) {
    return (
      <span className="inline-flex size-8 items-center justify-center [&>svg]:size-5">
        {props.statusIcon}
      </span>
    );
  }
  return (
    <span className="relative inline-flex size-8 shrink-0">
      <ProjectFavicon project={props.project} className="size-8" />
      <span className="absolute -right-1 -bottom-1 inline-flex size-4 items-center justify-center rounded-full bg-popover ring-2 ring-popover [&>svg]:size-4">
        {props.statusIcon}
      </span>
    </span>
  );
}
