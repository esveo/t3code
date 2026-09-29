/**
 * esveo fork: serves the attachments an Azure DevOps pull request embeds (see
 * `@t3tools/shared/azureDevOpsMedia`) through the machine's `az` sign-in.
 *
 * A token from `az account get-access-token` is minted for one tenant, and an organization in any
 * other tenant answers it with a redirect to its sign-in page. Azure names the tenant that owns an
 * organization in the `x-vss-resourcetenant` header of an anonymous request, so the token is asked
 * for that tenant explicitly — the same reason `AzureDevOpsPullRequestCli` avoids `az rest`.
 */
import {
  azureDevOpsMediaFileName,
  azureDevOpsMediaOrganization,
} from "@t3tools/shared/azureDevOpsMedia";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Mime from "effect/unstable/http/Mime";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";

/** Azure DevOps' application id, the resource every Azure DevOps access token is minted for. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const HOST = "dev.azure.com";
/** A redirect here is always the sign-in page, never the bytes, so none is followed. */
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
/** Which tenant owns an organization practically never changes. */
const TENANT_CACHE_TTL_MS = 60 * 60_000;
/** Tokens live about an hour; holding one shorter keeps a fresh sign-in taking effect soon. */
const TOKEN_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 32;
const FORWARDED_RESPONSE_HEADERS = ["content-length", "etag", "last-modified"] as const;
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// Same policy the GitHub media route gives an SVG, so one embedded in a body cannot run script.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const tenantCache = new Map<string, { readonly at: number; readonly tenant: string | null }>();
const tokenCache = new Map<string, { readonly at: number; readonly token: Redacted.Redacted }>();

function remember<V>(cache: Map<string, V>, key: string, value: V) {
  if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(key, value);
}

/** The tenant that owns `organization`, or null when Azure does not say (then `az` picks). */
const organizationTenant = Effect.fn("AzureDevOpsMediaFetch.organizationTenant")(function* (
  organization: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const cached = tenantCache.get(organization);
  if (cached !== undefined && now - cached.at < TENANT_CACHE_TTL_MS) return cached.tenant;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const tenant = yield* httpClient
    .execute(
      HttpClientRequest.get(
        `https://${HOST}/${encodeURIComponent(organization)}/_apis/connectionData`,
      ),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.map((response) => response.headers["x-vss-resourcetenant"]?.trim() || null),
      Effect.orElseSucceed(() => null),
    );
  // Only a definite answer is worth keeping; a network hiccup should be asked again.
  if (tenant !== null) remember(tenantCache, organization, { at: now, tenant });
  return tenant;
});

/** No sign-in is a normal state: the attachment then fails the way it does in a signed-out browser. */
const azureDevOpsToken = Effect.fn("AzureDevOpsMediaFetch.azureDevOpsToken")(function* (input: {
  readonly cwd: string;
  readonly tenant: string | null;
}) {
  const key = input.tenant ?? "";
  const now = yield* Clock.currentTimeMillis;
  const cached = tokenCache.get(key);
  if (cached !== undefined && now - cached.at < TOKEN_CACHE_TTL_MS) return cached.token;
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const token = yield* azure
    .execute({
      cwd: input.cwd,
      args: [
        "account",
        "get-access-token",
        "--resource",
        AZURE_DEVOPS_RESOURCE,
        ...(input.tenant === null ? [] : ["--tenant", input.tenant]),
        "--query",
        "accessToken",
        "--output",
        "tsv",
        "--only-show-errors",
      ],
    })
    .pipe(
      Effect.map((output) => output.stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
  if (token.length === 0) return null;
  const redacted = Redacted.make(token);
  remember(tokenCache, key, { at: now, token: redacted });
  return redacted;
});

const emptyResponse = (status: number, headers: Record<string, string>) =>
  HttpServerResponse.empty({ status, headers });

/**
 * Fetches the attachment with a token for its organization's tenant and streams it back, but only
 * when Azure answers with a picture or recording.
 */
const azureDevOpsMediaResponse = Effect.fn("AzureDevOpsMediaFetch.azureDevOpsMediaResponse")(
  function* (asset: { readonly url: string; readonly cwd: string; readonly expiresAt: number }) {
    const remainingSeconds = Math.floor(
      (asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000,
    );
    const headers: Record<string, string> = {
      "cache-control":
        remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
      "x-content-type-options": "nosniff",
    };
    // The URL was narrowed to dev.azure.com when it was signed, so the token stays on Azure.
    if (new URL(asset.url).hostname !== HOST) return emptyResponse(400, headers);
    const organization = azureDevOpsMediaOrganization(asset.url);
    const tenant = organization === null ? null : yield* organizationTenant(organization);
    const token = yield* azureDevOpsToken({ cwd: asset.cwd, tenant });
    const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(asset.url).pipe(
          HttpClientRequest.setHeaders({
            "accept-encoding": "identity",
            ...(token === null ? {} : { authorization: `Bearer ${Redacted.value(token)}` }),
          }),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));

    // A redirect is Azure sending an unsigned-in request to its login page.
    if (response.status >= 300 && response.status < 400) return emptyResponse(401, headers);
    if (response.status >= 400) {
      return emptyResponse(response.status >= 500 ? 502 : response.status, headers);
    }
    // Azure appends `; api-version=…` to the type, and omits it for some uploads.
    const upstreamType =
      response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const contentType = MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
      ? upstreamType
      : Option.getOrElse(Mime.getType(azureDevOpsMediaFileName(asset.url)), () => "").toLowerCase();
    if (!MEDIA_CONTENT_TYPE_PATTERN.test(contentType)) return emptyResponse(415, headers);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    headers["content-type"] = contentType;
    if (contentType === SVG_CONTENT_TYPE) {
      headers["content-security-policy"] = SVG_CONTENT_SECURITY_POLICY;
    }
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers,
      contentType,
    });
  },
);

/** The asset route's answer for an Azure DevOps attachment; a broken hop becomes a 502. */
export const azureDevOpsMediaHttpResponse = (asset: {
  readonly url: string;
  readonly cwd: string;
  readonly expiresAt: number;
}) =>
  azureDevOpsMediaResponse(asset).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Failed to fetch Azure DevOps media.", { url: asset.url, cause }),
    ),
    Effect.orElseSucceed(() =>
      emptyResponse(502, {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      }),
    ),
  );
