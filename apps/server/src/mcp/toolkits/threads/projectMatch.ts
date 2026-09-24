/**
 * Fork: thread orchestration. Which project a coordinator means when it names
 * one for start_thread or list_threads: by id, workspace path or title.
 */
interface ProjectCandidate {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

const withoutTrailingSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * The project named by `wanted`: an exact id or workspace path first, then a
 * title ignoring case. When no project or several match, the reason lists the
 * projects so the coordinator can pick one without another call.
 */
export function matchProject<Project extends ProjectCandidate>(
  projects: ReadonlyArray<Project>,
  wanted: string,
): { readonly project: Project } | { readonly error: string } {
  const target = withoutTrailingSlash(wanted.trim());
  const exact = projects.find(
    (project) => project.id === target || withoutTrailingSlash(project.workspaceRoot) === target,
  );
  if (exact) return { project: exact };
  const byTitle = projects.filter(
    (project) => project.title.trim().toLowerCase() === target.toLowerCase(),
  );
  if (byTitle.length === 1) return { project: byTitle[0]! };
  const listed = (byTitle.length > 1 ? byTitle : projects)
    .map((project) => `${project.title} (${project.id})`)
    .join(", ");
  return {
    error:
      byTitle.length > 1
        ? `Several projects are titled ${target}; pass the id of one: ${listed}.`
        : `No project matches ${target}. Projects: ${listed || "none"}.`,
  };
}
