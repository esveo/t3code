import type { AssetResource } from "@t3tools/contracts";
import { azureDevOpsMediaFetchUrl } from "@t3tools/shared/azureDevOpsMedia";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";

export type PullRequestMediaResource = Extract<
  AssetResource,
  { readonly _tag: "github-media" | "azure-devops-media" }
>;

/**
 * esveo fork: the signed asset a pull request body's image loads through when only a credential
 * decides whether it loads — GitHub media through `gh`, Azure DevOps attachments through `az`.
 * Null for every other source, which keeps loading directly.
 */
export function pullRequestMediaResource(
  cwd: string,
  source: string,
  repository?: string | null,
): PullRequestMediaResource | null {
  const githubUrl = githubMediaFetchUrl(source);
  if (githubUrl !== null) {
    if (!repository) return { _tag: "github-media", cwd, url: githubUrl };
    return {
      _tag: "github-media",
      cwd,
      url: githubUrl,
      ...(repository ? { repository } : {}),
    };
  }
  const azureDevOpsUrl = azureDevOpsMediaFetchUrl(source);
  return azureDevOpsUrl === null ? null : { _tag: "azure-devops-media", cwd, url: azureDevOpsUrl };
}
