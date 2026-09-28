/**
 * Attachments an Azure DevOps pull request body or comment embeds. Azure stores a pasted
 * screenshot as a pull request attachment,
 * `dev.azure.com/<org>/<project>/_apis/git/repositories/<repo>/pullRequests/<n>/attachments/<file>`,
 * and answers a request without an Azure sign-in with a redirect to its login page. The
 * renderer carries no Azure session, so the server fetches these with the `az` credential.
 */

const HOST = "dev.azure.com";
const ATTACHMENT_PATH_PATTERN =
  /^\/([^/]+)\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/attachments\/[^/]+$/iu;

/**
 * The URL to fetch with an Azure credential for `source`, or null when the source is not an
 * Azure DevOps pull request attachment — those keep loading directly.
 */
export function azureDevOpsMediaFetchUrl(source: string): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== HOST) return null;
  // Query and fragment say nothing about which bytes Azure serves.
  return ATTACHMENT_PATH_PATTERN.test(url.pathname) ? `https://${HOST}${url.pathname}` : null;
}

/** The organization the attachment belongs to, which decides the tenant its token comes from. */
export function azureDevOpsMediaOrganization(fetchUrl: string): string | null {
  const match = ATTACHMENT_PATH_PATTERN.exec(new URL(fetchUrl).pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Last path segment, for the signed URL's display name and a content type Azure omits. */
export function azureDevOpsMediaFileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "azure-devops-media";
}
