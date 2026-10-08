import type { EnvironmentId, ProjectReadFileError } from "@t3tools/contracts";

import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";

import { useProjectFileQuery } from "../files/projectFilesQueryState";

/** A failed realpath of the target is how the server reports a path that does not exist. */
export function isMissingFileReadError(error: ProjectReadFileError | null): boolean {
  return error?.failure === "operation_failed" && error.operation === "realpath-target";
}

/**
 * The same relative path below the home folder, or null when there is none to try.
 * Agents often name home files like `.claude/settings.json` without the `~/`.
 */
export function homeFallbackPath(path: string | null, cwd: string): string | null {
  if (path === null || path.trim() === "" || isAbsolutePath(path) || path.startsWith("~")) {
    return null;
  }
  const candidate = resolvePathLinkTarget(`~/${path}`, cwd);
  if (!isAbsolutePath(candidate)) return null;
  // A workspace at the home folder already looked there.
  return candidate === resolvePathLinkTarget(path, cwd) ? null : candidate;
}

/**
 * Opens a workspace-relative path from the home folder when the workspace has no such
 * file. The home path is a host file, so the preview shows it read-only.
 * `missingHomePath` is set when neither location has the file.
 */
export function useHomePathFallback(
  environmentId: EnvironmentId,
  cwd: string,
  path: string | null,
  enabled: boolean,
): { path: string | null; missingHomePath: string | null } {
  const primary = useProjectFileQuery(environmentId, cwd, path, enabled && path !== null);
  const candidate =
    enabled && isMissingFileReadError(primary.readError) ? homeFallbackPath(path, cwd) : null;
  const fallback = useProjectFileQuery(environmentId, cwd, candidate, candidate !== null);
  if (candidate === null) return { path, missingHomePath: null };
  if (isMissingFileReadError(fallback.readError)) return { path, missingHomePath: candidate };
  return { path: candidate, missingHomePath: null };
}

/** The home path the preview also tried, shown under a missing file's error. */
export function HomePathFallbackAttempt({ homePath }: { homePath: string | null }) {
  if (homePath === null) return null;
  return (
    <p className="text-muted-foreground">
      Also looked in the home folder
      <code className="block break-all font-mono text-foreground select-all">{homePath}</code>
    </p>
  );
}
