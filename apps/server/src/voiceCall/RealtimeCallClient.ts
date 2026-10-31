/**
 * Fork: creates GPT-Live calls on the user's ChatGPT login and holds their
 * event sideband. The client's WebRTC peer carries the audio; this side only
 * reads and writes events.
 *
 * Errors never carry the request: its headers hold the access token.
 */
import type { VoiceCallVoice } from "@t3tools/contracts";
import { VoiceCallError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  decodeRealtimeEvent,
  type RealtimeEvent,
  type RealtimeOutbound,
} from "./realtimeEvents.ts";

const CALLS_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const sidebandUrl = (realtimeCallId: string) =>
  `wss://api.openai.com/v1/live/${encodeURIComponent(realtimeCallId)}`;
const REALTIME_MODEL = "gpt-live-1-codex";

export interface RealtimeAuth {
  readonly accessToken: string;
  readonly accountId: string;
}

export interface RealtimeSessionConfig {
  readonly instructions: string;
  readonly voice: VoiceCallVoice;
}

export interface RealtimeSideband {
  /** Ends when the socket closes. */
  readonly events: Stream.Stream<RealtimeEvent>;
  readonly send: (event: RealtimeOutbound) => Effect.Effect<void, VoiceCallError>;
}

export class RealtimeCallClient extends Context.Service<
  RealtimeCallClient,
  {
    readonly createCall: (input: {
      readonly auth: RealtimeAuth;
      readonly offerSdp: string;
      readonly session: RealtimeSessionConfig;
    }) => Effect.Effect<
      { readonly answerSdp: string; readonly realtimeCallId: string },
      VoiceCallError
    >;
    /** Closing the scope ends the realtime session, so nothing keeps billing after a crash. */
    readonly openSideband: (input: {
      readonly auth: RealtimeAuth;
      readonly realtimeCallId: string;
    }) => Effect.Effect<RealtimeSideband, VoiceCallError, Scope.Scope>;
  }
>()("t3/voiceCall/RealtimeCallClient") {}

/** What Codex sends; the endpoint rejects calls without the quicksilver headers. */
const codexHeaders = (auth: RealtimeAuth) => ({
  Authorization: `Bearer ${auth.accessToken}`,
  "ChatGPT-Account-ID": auth.accountId,
  originator: "codex_cli_rs",
  "openai-alpha": "quicksilver=v2",
  "User-Agent": "codex_cli_rs/0.163.0 (esveo code)",
});

const isVoiceCallError = Schema.is(VoiceCallError);
const JsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(JsonString);
const encodeJson = Schema.encodeSync(JsonString);

const excerpt = (text: string) => text.replace(/\s+/g, " ").slice(0, 200);

const createCall = Effect.fn("RealtimeCallClient.createCall")(
  function* (
    http: HttpClient.HttpClient,
    { auth, offerSdp, session }: Parameters<RealtimeCallClient["Service"]["createCall"]>[0],
  ) {
    const response = yield* http.execute(
      HttpClientRequest.post(CALLS_URL).pipe(
        HttpClientRequest.setHeaders(codexHeaders(auth)),
        HttpClientRequest.bodyJsonUnsafe({
          sdp: offerSdp,
          session: {
            model: REALTIME_MODEL,
            instructions: session.instructions,
            audio: { output: { voice: session.voice } },
            // The voice hands work to us instead of calling tools itself.
            delegation: { type: "client" },
          },
        }),
      ),
    );
    const body = yield* response.text;
    if (response.status === 401 || response.status === 403) {
      return yield* new VoiceCallError({
        message: `ChatGPT refused the call (${response.status}). Renew the Codex login.`,
        reason: "codex-login-expired",
      });
    }
    if (response.status !== 200 && response.status !== 201) {
      return yield* new VoiceCallError({
        message: `ChatGPT refused the call (${response.status}): ${excerpt(body)}`,
      });
    }
    const realtimeCallId = response.headers["location"]?.split("/").pop();
    if (!realtimeCallId || !body.startsWith("v=")) {
      return yield* new VoiceCallError({ message: "ChatGPT answered the call without a session." });
    }
    return { answerSdp: body, realtimeCallId };
  },
  Effect.timeoutOrElse({
    duration: "20 seconds",
    orElse: () => Effect.fail(new VoiceCallError({ message: "ChatGPT did not answer the call." })),
  }),
  Effect.mapError((error) =>
    isVoiceCallError(error)
      ? error
      : new VoiceCallError({ message: `Could not reach ChatGPT (${errorTag(error)}).` }),
  ),
);

const errorTag = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "unknown";

/**
 * Node's WebSocket (undici) takes request headers as a second-argument
 * option; the DOM typing does not know about it.
 */
type HeaderWebSocketConstructor = new (
  url: string,
  options: { readonly headers: Record<string, string> },
) => WebSocket;

const openSideband = Effect.fn("RealtimeCallClient.openSideband")(function* ({
  auth,
  realtimeCallId,
}: Parameters<RealtimeCallClient["Service"]["openSideband"]>[0]) {
  const events = yield* Queue.unbounded<RealtimeEvent, Cause.Done>();
  const socket = yield* Effect.acquireRelease(
    Effect.callback<WebSocket, VoiceCallError>((resume) => {
      const socket = new (WebSocket as unknown as HeaderWebSocketConstructor)(
        sidebandUrl(realtimeCallId),
        { headers: codexHeaders(auth) },
      );
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        const event = Option.flatMap(decodeJson(message.data), decodeRealtimeEvent);
        if (Option.isSome(event)) Queue.offerUnsafe(events, event.value);
      });
      socket.addEventListener("close", () => {
        Queue.endUnsafe(events);
      });
      socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
      socket.addEventListener(
        "error",
        () => {
          if (socket.readyState !== WebSocket.OPEN) {
            resume(
              Effect.fail(
                new VoiceCallError({ message: "The voice session sideband did not open." }),
              ),
            );
          }
        },
        { once: true },
      );
      return Effect.sync(() => socket.close());
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(new VoiceCallError({ message: "The voice session sideband timed out." })),
      }),
    ),
    (socket) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeJson({ type: "session.close" } satisfies RealtimeOutbound));
        }
        socket.close();
        Queue.endUnsafe(events);
      }),
  );
  return {
    events: Stream.fromQueue(events),
    send: (event) =>
      Effect.suspend(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return Effect.fail(new VoiceCallError({ message: "The voice session has ended." }));
        }
        socket.send(encodeJson(event));
        return Effect.void;
      }),
  } satisfies RealtimeSideband;
});

export const layer = Layer.effect(
  RealtimeCallClient,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return RealtimeCallClient.of({
      createCall: (input) => createCall(http, input),
      openSideband,
    });
  }),
);
