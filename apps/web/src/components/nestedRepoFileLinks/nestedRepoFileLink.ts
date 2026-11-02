/** Resolves agent file links relative to repositories nested one folder below the workspace. */

// Bounds the probes a single click can send for a root with many folders.
const NESTED_REPO_FILE_LOOKUP_MAX_DIRECTORIES = 100;

export interface NestedRepoFileProbe {
  /** False only when nothing exists at the workspace-relative path. */
  readonly pathExists: (relativePath: string) => Promise<boolean>;
  /** Workspace-relative paths of the root's immediate folders, ignored ones included. */
  readonly listRootDirectories: () => Promise<ReadonlyArray<string>>;
}

function relativePathSegments(relativePath: string): string[] | null {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0 || /^(?:[\\/]|[A-Za-z]:|~)/.test(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  return segments.includes("..") ? null : segments;
}

/** Bare filenames go through the basename lookup instead; absolute paths open as-is. */
export function needsNestedRepoFileLookup(relativePath: string): boolean {
  const segments = relativePathSegments(relativePath);
  return segments !== null && segments.length > 1;
}

/**
 * The nested path to open instead of `relativePath`, or null to keep it: when
 * it exists at the root, or when no folder or more than one holds it.
 */
export async function resolveNestedRepoFilePath(
  relativePath: string,
  probe: NestedRepoFileProbe,
): Promise<string | null> {
  const segments = relativePathSegments(relativePath);
  if (segments === null || segments.length < 2) return null;
  const normalized = segments.join("/");
  if (await probe.pathExists(normalized)) return null;

  const directories = (await probe.listRootDirectories()).slice(
    0,
    NESTED_REPO_FILE_LOOKUP_MAX_DIRECTORIES,
  );
  const candidates = directories.map((directory) => `${directory}/${normalized}`);
  const exists = await Promise.all(candidates.map((candidate) => probe.pathExists(candidate)));
  const matches = candidates.filter((_, index) => exists[index]);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
