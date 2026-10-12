import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Kept for fork compatibility. Bitbucket credentials now live in upstream's
 * unified Source Control settings and this legacy panel has no mount point.
 */
export function BitbucketCredentialsSettings(_props: {
  readonly environmentId: EnvironmentId;
  readonly onSaved: () => void;
}) {
  return null;
}
