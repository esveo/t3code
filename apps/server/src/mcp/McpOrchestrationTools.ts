/**
 * Fork: thread orchestration and its decisions are switched in Settings while
 * agent sessions run. The MCP server reads both switches live instead of from
 * the session's credential: `tools/list` offers the tools only while their
 * switch is on, and every open MCP connection hears
 * `notifications/tools/list_changed` when one flips, so a running agent gains
 * or loses them without a new session.
 *
 * Effect's streamable HTTP transport buffers each POST into one JSON response
 * and answers `GET /mcp` with 405, so it cannot push that notification. The
 * auth middleware hands authenticated GETs to `openNotificationStream`
 * instead: the SSE stream the MCP spec defines for server-initiated messages,
 * which Claude Code and Codex open after initializing.
 */
import type { ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";

export interface OrchestrationToolAccess {
  readonly threads: boolean;
  readonly decisions: boolean;
}

const off: OrchestrationToolAccess = { threads: false, decisions: false };

// Read synchronously by the tools' `McpSchema.EnabledWhen` predicates; only the
// layer below writes it.
let current: OrchestrationToolAccess = off;

/** Whether the tools of this switch are on right now; decisions need orchestration too. */
export const isOrchestrationToolOn = (tools: keyof OrchestrationToolAccess): boolean =>
  current[tools];

const accessOf = (settings: ServerSettingsValue): OrchestrationToolAccess => ({
  threads: settings.enableThreadOrchestration,
  decisions: settings.enableThreadOrchestration && settings.enableThreadDecisions,
});

const encoder = new TextEncoder();
export const LIST_CHANGED_MESSAGE = `{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`;
const LIST_CHANGED_EVENT = encoder.encode(`event: message\ndata: ${LIST_CHANGED_MESSAGE}\n\n`);
// Comments keep idle proxies and the client's body timeout (undici: 5 minutes) from closing it.
const KEEPALIVE = encoder.encode(": keepalive\n\n");
const KEEPALIVE_INTERVAL = "30 seconds";

export class McpOrchestrationTools extends Context.Service<
  McpOrchestrationTools,
  {
    /** The SSE response for an authenticated `GET /mcp`. */
    readonly openNotificationStream: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("t3/mcp/McpOrchestrationTools") {}

export const layer = Layer.effect(
  McpOrchestrationTools,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const listChanged = yield* PubSub.unbounded<void>();
    // Subscribe before reading, so a change in between is not lost.
    const changes = yield* settings.subscribeChanges;
    current = yield* settings.getSettings.pipe(
      Effect.map(accessOf),
      Effect.orElseSucceed(() => off),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => (current = off)));
    yield* changes.pipe(
      Stream.runForEach((next) => {
        const access = accessOf(next);
        if (access.threads === current.threads && access.decisions === current.decisions) {
          return Effect.void;
        }
        current = access;
        return PubSub.publish(listChanged, undefined);
      }),
      Effect.forkScoped,
    );

    return McpOrchestrationTools.of({
      openNotificationStream: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(request.headers.accept ?? "").includes("text/event-stream")) {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });
        }
        return HttpServerResponse.stream(
          Stream.merge(
            Stream.fromPubSub(listChanged).pipe(Stream.map(() => LIST_CHANGED_EVENT)),
            Stream.tick(KEEPALIVE_INTERVAL).pipe(Stream.map(() => KEEPALIVE)),
          ),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-store", connection: "keep-alive" },
          },
        );
      }),
    });
  }),
);
