import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { azureDevOpsMediaHttpResponse } from "./AzureDevOpsMediaFetch.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

const attachmentUrl = (organization: string) =>
  `https://dev.azure.com/${organization}/d55e6e6f/_apis/git/repositories/a65e7292/pullRequests/402/attachments/shot.png`;
const asset = (organization: string) => ({
  url: attachmentUrl(organization),
  cwd: "/repo",
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/** Azure as the route sees it: the organization's tenant, then the attachment behind a token. */
function fakeAzure(options: {
  readonly tenant: string;
  readonly attachment: (authorization: string | undefined) => Response;
}) {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const client = HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const response = request.url.endsWith("/_apis/connectionData")
      ? new Response(null, { status: 302, headers: { "x-vss-resourcetenant": options.tenant } })
      : options.attachment(request.headers.authorization);
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { requests, client };
}

function fakeAz(token: string) {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
    execute: (input) =>
      Effect.sync(() => {
        calls.push(input.args);
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: token,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  return { calls, layer };
}

const status = (response: HttpServerResponse.HttpServerResponse) => response.status;

describe("AzureDevOpsMediaFetch", () => {
  it.effect("asks for a token in the organization's own tenant and keeps it on Azure", () => {
    const azure = fakeAzure({
      tenant: "tenant-of-ljb",
      attachment: (authorization) =>
        new Response("png", {
          status: authorization ? 200 : 302,
          headers: { "content-type": "image/png; api-version=7.1" },
        }),
    });
    const az = fakeAz("signed-in-token");
    return Effect.gen(function* () {
      const first = yield* azureDevOpsMediaHttpResponse(asset("org-a"));
      const second = yield* azureDevOpsMediaHttpResponse(asset("org-a"));
      expect([status(first), status(second)]).toEqual([200, 200]);
      expect(first.headers["content-type"]).toBe("image/png");
      // One tenant lookup and one token for both requests.
      expect(az.calls).toHaveLength(1);
      expect(az.calls[0]).toEqual(expect.arrayContaining(["--tenant", "tenant-of-ljb"]));
      expect(azure.requests.filter((request) => request.url.endsWith("/connectionData"))).toEqual([
        { url: "https://dev.azure.com/org-a/_apis/connectionData", authorization: undefined },
      ]);
      expect(
        azure.requests
          .filter((request) => request.url.includes("/attachments/"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer signed-in-token", "Bearer signed-in-token"]);
    }).pipe(
      Effect.provide(az.layer),
      Effect.provideService(HttpClient.HttpClient, azure.client),
      Effect.scoped,
    );
  });

  it.effect("answers a sign-in redirect with 401 when az has no token", () => {
    const azure = fakeAzure({
      tenant: "tenant-b",
      attachment: () =>
        new Response(null, { status: 302, headers: { location: "https://spsprodweu5.vssps" } }),
    });
    const az = fakeAz("");
    return Effect.gen(function* () {
      expect(status(yield* azureDevOpsMediaHttpResponse(asset("org-b")))).toBe(401);
      expect(azure.requests.at(-1)?.authorization).toBeUndefined();
    }).pipe(
      Effect.provide(az.layer),
      Effect.provideService(HttpClient.HttpClient, azure.client),
      Effect.scoped,
    );
  });

  it.effect("serves pictures and recordings only", () => {
    const azure = fakeAzure({
      tenant: "tenant-c",
      attachment: () =>
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    const az = fakeAz("token-c");
    return Effect.gen(function* () {
      // The name says png, but Azure's own answer (a page) is what is refused.
      const refused = yield* azureDevOpsMediaHttpResponse({
        ...asset("org-c"),
        url: attachmentUrl("org-c").replace("shot.png", "notes.txt"),
      });
      expect(status(refused)).toBe(415);
    }).pipe(
      Effect.provide(az.layer),
      Effect.provideService(HttpClient.HttpClient, azure.client),
      Effect.scoped,
    );
  });
});

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-azure-media-test-",
});
const assetLayer = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({ getTurnItem: () => Effect.succeed(null) }),
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(configLayer)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("azure-devops-media assets", () => {
  it.effect("sign only Azure DevOps pull request attachments", () =>
    Effect.gen(function* () {
      const issued = yield* issueAssetUrl({
        resource: { _tag: "azure-devops-media", cwd: "/repo", url: `${attachmentUrl("ljb")}?x=1` },
      });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      expect(yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1))).toEqual({
        kind: "azure-devops-media",
        url: attachmentUrl("ljb"),
        cwd: "/repo",
        expiresAt: issued.expiresAt,
      });

      const refused = yield* issueAssetUrl({
        resource: { _tag: "azure-devops-media", cwd: "/repo", url: "https://example.com/a.png" },
      }).pipe(Effect.flip);
      expect(refused._tag).toBe("AssetAzureDevOpsMediaUrlValidationError");
    }).pipe(Effect.provide(assetLayer)),
  );
});
