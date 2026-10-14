/**
 * Fork: the class overrides a sidebar thread card takes on top of upstream's
 * three-line layout. Two-line cards hide the third line and trail the title
 * with the machine and provider icons; inside a project run the project line
 * gives way to the branch, so the card tightens further.
 *
 * Upstream's own class strings stay untouched in `Sidebar.tsx`; `cn` merges
 * these over them, so a conflicting height or margin here wins.
 */
export interface ThreadCardLayout {
  readonly item: string | undefined;
  readonly content: string | undefined;
  readonly firstLine: string | undefined;
  readonly titleLine: string | undefined;
  readonly thirdLine: string | undefined;
}

const THREE_LINE_LAYOUT: ThreadCardLayout = {
  item: undefined,
  content: undefined,
  firstLine: undefined,
  titleLine: undefined,
  thirdLine: undefined,
};

const TWO_LINE_LAYOUT: ThreadCardLayout = {
  item: "[contain-intrinsic-size:auto_64px]",
  content: "h-[3.75rem]",
  firstLine: undefined,
  titleLine: "items-center gap-1.5",
  thirdLine: "hidden",
};

// The project line is gone, so the card gives back the height and padding
// that line used to justify.
const TWO_LINE_RUN_LAYOUT: ThreadCardLayout = {
  item: "[contain-intrinsic-size:auto_56px]",
  content: "h-[3.25rem] py-[calc(var(--sidebar-content-inset)-0.125rem)]",
  firstLine: "h-4",
  titleLine: "mt-0.5 items-center gap-1.5",
  thirdLine: "hidden",
};

export function threadCardLayout(input: {
  readonly twoLineThreadCards: boolean;
  readonly inProjectRun: boolean;
}): ThreadCardLayout {
  if (!input.twoLineThreadCards) return THREE_LINE_LAYOUT;
  return input.inProjectRun ? TWO_LINE_RUN_LAYOUT : TWO_LINE_LAYOUT;
}
