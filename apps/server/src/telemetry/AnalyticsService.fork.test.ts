import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

// Fork: builds of the fork must not report to upstream's PostHog project unless asked to.
it.layer(NodeServices.layer)("AnalyticsService in the fork", (it) => {
  it.effect("sends nothing when T3CODE_TELEMETRY_ENABLED is unset", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-fork-default-",
      });
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ T3CODE_POSTHOG_HOST: "http://localhost" }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.fork.default", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
