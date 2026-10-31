import type { ScopedThreadRef } from "@t3tools/contracts";
import { ImagesIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";

export interface ThreadImagesSurfaceProps {
  readonly available: boolean;
  readonly open: () => void;
}

export const UNAVAILABLE_THREAD_IMAGES: ThreadImagesSurfaceProps = {
  available: false,
  open: () => {},
};

export const ThreadImagesTabIcon = ImagesIcon;

/** Fork: the Images tab's entry in the right panel's launcher. */
export const THREAD_IMAGES_ACTION = {
  label: "Images",
  description: "Every image in this thread, its subagents and its sub-threads.",
  icon: ImagesIcon,
  shortcut: "A",
};

/** Plain, not a hook: the panel hook that calls it is what the React Compiler memoizes. */
export function threadImagesSurface(threadRef: ScopedThreadRef | null): ThreadImagesSurfaceProps {
  const open = () => {
    if (threadRef) useRightPanelStore.getState().open(threadRef, "thread-images");
  };
  return { available: threadRef !== null, open };
}
