import type { ProjectIconColor } from "@t3tools/contracts";
import { deriveProjectIdentity } from "../../projectIdentity";
import type { ProjectFaviconProject } from "../ProjectFavicon";
import type { SidebarProjectRunPlacement } from "./sidebarProjectRuns.logic";
import { cn } from "~/lib/utils";

/**
 * The hue a run is drawn in: the project's own icon color when it picked one,
 * otherwise the generated one its monogram already uses, so the rail always
 * matches the favicon next to it.
 */
export function resolveProjectRunAccent(
  project: Pick<ProjectFaviconProject, "title" | "projectIcon"> | null,
): ProjectIconColor {
  if (project === null) return "gray";
  const icon = project.projectIcon;
  if (icon?.kind === "monogram" || icon?.kind === "lucide") return icon.color;
  return deriveProjectIdentity(project.title).color;
}

// Written out per color: Tailwind only ships classes it can read in source.
const RUN_RAIL_CLASS_NAMES: Record<ProjectIconColor, string> = {
  gray: "before:bg-gray-500/35",
  red: "before:bg-red-500/35",
  orange: "before:bg-orange-500/35",
  amber: "before:bg-amber-500/35",
  yellow: "before:bg-yellow-500/35",
  lime: "before:bg-lime-500/35",
  green: "before:bg-green-500/35",
  emerald: "before:bg-emerald-500/35",
  teal: "before:bg-teal-500/35",
  cyan: "before:bg-cyan-500/35",
  sky: "before:bg-sky-500/35",
  blue: "before:bg-blue-500/35",
  indigo: "before:bg-indigo-500/35",
  violet: "before:bg-violet-500/35",
  purple: "before:bg-purple-500/35",
  fuchsia: "before:bg-fuchsia-500/35",
  pink: "before:bg-pink-500/35",
  rose: "before:bg-rose-500/35",
};

/**
 * The rail a row in a run draws down its left edge. The row keeps its own
 * height: the rail rides the list padding, and the run's ends taper so a run
 * reads as one block without a box around it.
 */
export function sidebarProjectRunRowClassName(input: {
  placement: SidebarProjectRunPlacement | null;
  accent: ProjectIconColor;
}): string | undefined {
  if (input.placement === null) return undefined;
  return cn(
    "relative pl-3 before:pointer-events-none before:absolute before:left-[0.375rem] before:w-px before:content-['']",
    RUN_RAIL_CLASS_NAMES[input.accent],
    input.placement === "only"
      ? "before:inset-y-2"
      : input.placement === "first"
        ? "before:top-2 before:bottom-0"
        : input.placement === "last"
          ? "before:top-0 before:bottom-2"
          : "before:inset-y-0",
  );
}
