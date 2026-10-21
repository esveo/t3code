import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollTextIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";

export interface ForkInstructionsSurfaceProps {
  readonly available: boolean;
  readonly open: () => void;
}

export const UNAVAILABLE_FORK_INSTRUCTIONS: ForkInstructionsSurfaceProps = {
  available: false,
  open: () => {},
};

export const ForkInstructionsTabIcon = ScrollTextIcon;

/** Fork: the Instructions tab's entry in the right panel's launcher. */
export const FORK_INSTRUCTIONS_ACTION = {
  label: "Instructions",
  description: "The instruction file the thread's agent reads, for the project or everywhere.",
  icon: ScrollTextIcon,
  shortcut: "I",
};

/** Plain, not a hook: the panel hook that calls it is what the React Compiler memoizes. */
export function forkInstructionsSurface(
  threadRef: ScopedThreadRef | null,
): ForkInstructionsSurfaceProps {
  const open = () => {
    if (threadRef) useRightPanelStore.getState().open(threadRef, "instructions");
  };
  return { available: threadRef !== null, open };
}
