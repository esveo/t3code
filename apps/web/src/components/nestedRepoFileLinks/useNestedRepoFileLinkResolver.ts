import {
  AuthFilesystemReadScope,
  ProjectReadFileError,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { needsNestedRepoFileLookup, resolveNestedRepoFilePath } from "./nestedRepoFileLink";

const isProjectReadFileError = Schema.is(ProjectReadFileError);

/**
 * Resolves a chat file link that is missing at the workspace root to the one
 * nested folder holding it (see `nestedRepoFileLink.ts`). The read keys match
 * the files panel's, so the panel reuses the probe of the path it opens.
 */
export function useNestedRepoFileLinkResolver(
  environmentId: EnvironmentId | null,
  cwd: string | undefined,
) {
  const readProjectFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
  });
  const listProjectEntries = useAtomQueryRunner(projectEnvironment.listEntries, {
    reportFailure: false,
  });

  return useCallback(
    async (relativePath: string): Promise<string | null> => {
      if (
        !cwd ||
        environmentId === null ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
      ) {
        return null;
      }
      return resolveNestedRepoFilePath(relativePath, {
        pathExists: async (path) => {
          const result = await readProjectFile({
            environmentId,
            input: { cwd, relativePath: path },
          });
          if (result._tag === "Success") return true;
          // A folder or a binary file exists too; only a failed realpath means nothing is there.
          const error = squashAtomCommandFailure(result);
          return !(
            isProjectReadFileError(error) &&
            error.failure === "operation_failed" &&
            error.operation === "realpath-target"
          );
        },
        listRootDirectories: async () => {
          const result = await listProjectEntries({
            environmentId,
            input: { cwd, directoryPath: "" },
          });
          return result._tag === "Success"
            ? result.value.entries
                .filter((entry) => entry.kind === "directory")
                .map((entry) => entry.path)
            : [];
        },
      });
    },
    [cwd, environmentId, listProjectEntries, readProjectFile],
  );
}

export { needsNestedRepoFileLookup };
