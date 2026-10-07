import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpOrchestrationTools from "./McpOrchestrationTools.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { ThreadsToolkit } from "./toolkits/threads/tools.ts";

/** Test settings that announce every update, as the real service does. */
const SettingsLive = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const base = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provide(ServerSettings.layerTest()),
    );
    const changes = yield* PubSub.unbounded<ServerSettingsValue>();
    return {
      ...base,
      updateSettings: (patch) =>
        base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    } satisfies ServerSettings.ServerSettingsService["Service"];
  }),
);

// The switches are what is under test, so every handler just answers.
const ThreadsToolkitStubLive = McpHttpServer.toolkitRegistration(
  ThreadsToolkit,
  McpToolAccess.toLayer(
    ThreadsToolkit,
    Object.fromEntries(
      Object.keys(ThreadsToolkit.tools).map((name) => [
        name,
        McpToolAccess.reads(() =>
          Effect.succeed(name === "list_decisions" ? { decisions: [] } : ({} as never)),
        ),
      ]),
    ) as never,
  ),
);

const TestLayer = Layer.mergeAll(ThreadsToolkitStubLive).pipe(
  Layer.provideMerge(McpHttpServer.layerMcpTransport),
  Layer.provideMerge(McpSessionRegistry.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const toolNames = (body: unknown) =>
  (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools.map(
    (tool) => tool.name,
  );

it.effect("offers the decision tools only while their switch is on, live", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(TestLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      // The session's credential does not grant "decisions".
      const { config } = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("coordinator"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(["pull-requests"]),
      }).pipe(Effect.map((issued) => issued!));
      const settings = yield* ServerSettings.ServerSettingsService;

      const headers = {
        accept: "application/json, text/event-stream",
        authorization: config.authorizationHeader,
      };
      const initialized = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(yield* initialized.json).toMatchObject({
        result: { capabilities: { tools: { listChanged: true } } },
      });
      const session = {
        ...headers,
        "mcp-session-id": initialized.headers["mcp-session-id"]!,
        "mcp-protocol-version": "2025-06-18",
      };
      let requestId = 1;
      const rpc = (method: string, params: unknown) =>
        httpClient
          .post("/mcp", {
            headers: session,
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
              "application/json",
            ),
          })
          .pipe(Effect.flatMap((response) => response.json));
      const listTools = rpc("tools/list", {}).pipe(Effect.map(toolNames));
      const callListDecisions = rpc("tools/call", { name: "list_decisions", arguments: {} });

      // Server-initiated messages arrive on the GET stream.
      const events = yield* Queue.unbounded<string>();
      const stream = yield* httpClient.get("/mcp", {
        headers: { ...session, accept: "text/event-stream" },
      });
      expect(stream.headers["content-type"]).toBe("text/event-stream");
      yield* stream.stream.pipe(
        Stream.decodeText,
        Stream.filter((chunk) => chunk.startsWith("event:")),
        Stream.runForEach((chunk) => Queue.offer(events, chunk)),
        Effect.forkScoped,
      );
      const nextEvent = Queue.take(events).pipe(
        Effect.map((event) => event.split("data: ")[1]?.trim()),
      );
      const listChanged = McpOrchestrationTools.LIST_CHANGED_MESSAGE;

      // Decisions off (the default); adopt_thread is always there.
      const before = yield* listTools;
      expect(before).toContain("adopt_thread");
      expect(before).not.toContain("upsert_decision");
      expect(yield* callListDecisions).toMatchObject({
        error: { message: expect.stringMatching(/not found/) },
      });

      // Decisions on: the running session hears of it and may call them.
      yield* settings.updateSettings({ enableThreadDecisions: true });
      expect(yield* nextEvent).toBe(listChanged);
      expect(yield* listTools).toEqual(
        expect.arrayContaining([
          "adopt_thread",
          "upsert_decision",
          "resolve_decision",
          "list_decisions",
        ]),
      );
      expect(yield* callListDecisions).toMatchObject({
        result: { isError: false, structuredContent: { decisions: [] } },
      });

      // A change that leaves the switch as it is stays quiet.
      yield* settings.updateSettings({ enableAgentDeviceAccess: true });

      // Decisions off again: the decision tools go, and calls fail.
      yield* settings.updateSettings({ enableThreadDecisions: false });
      expect(yield* nextEvent).toBe(listChanged);
      const after = yield* listTools;
      expect(after.filter((name) => name in ThreadsToolkit.tools)).toEqual(["adopt_thread"]);
      expect(yield* callListDecisions).toMatchObject({
        error: { message: expect.stringMatching(/not found/) },
      });
      expect(yield* Queue.size(events)).toBe(0);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, SettingsLive))),
);
