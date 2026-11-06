/**
 * Fork: GET requests to Notion's REST API with the integration's secret,
 * paced to Notion's ~3 requests per second and retried on 429.
 */
import { EsveoNotionError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionResponse {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly body: unknown;
}

/** The wire; tests replace it with recorded responses. */
export class NotionTransport extends Context.Service<
  NotionTransport,
  {
    readonly get: (path: string, secret: string) => Effect.Effect<NotionResponse, EsveoNotionError>;
  }
>()("t3/esveoNotion/notionApi/NotionTransport") {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const networkError = () =>
  new EsveoNotionError({ reason: "network", message: "Notion is not reachable." });

export const httpTransport = Layer.effect(
  NotionTransport,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return NotionTransport.of({
      get: Effect.fn("NotionTransport.get")(function* (path: string, secret: string) {
        const response = yield* http.execute(
          HttpClientRequest.get(`${NOTION_API}${path}`).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${secret}`,
              "notion-version": NOTION_VERSION,
            }),
          ),
        );
        const text = yield* response.text;
        return {
          status: response.status,
          retryAfter: response.headers["retry-after"],
          body: Option.getOrNull(decodeJson(text)),
        };
      }, Effect.mapError(networkError)),
    });
  }),
);

const MAX_RETRY_AFTER_SECONDS = 30;

const retryAfterSeconds = (header: string | undefined) => {
  const seconds = header === undefined ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : 1;
};

const notionCode = (body: unknown) =>
  typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code
    : null;

const notionMessage = (body: unknown) =>
  typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : "";

/** A database id sent to the page endpoint; the caller retries on /databases. */
export const isDatabaseIdError = (response: NotionResponse) =>
  response.status === 400 && /is a database, not a page/i.test(notionMessage(response.body));

/** Notion's status and error code as the viewer's error, without Notion's raw message. */
export function toNotionError(
  response: NotionResponse,
  integrationName: string | null,
): EsveoNotionError {
  const code = notionCode(response.body);
  if (response.status === 401 || code === "unauthorized") {
    return new EsveoNotionError({
      reason: "unauthorized",
      message: "Notion rejected the integration secret.",
    });
  }
  if (response.status === 404 || response.status === 403 || code === "restricted_resource") {
    return new EsveoNotionError({
      reason: "not_shared",
      message: "This page is not shared with the integration.",
      ...(integrationName === null ? {} : { integrationName }),
    });
  }
  if (response.status === 429) {
    return new EsveoNotionError({
      reason: "rate_limited",
      message: "Notion asked to slow down.",
      retryAfterSeconds: retryAfterSeconds(response.retryAfter),
    });
  }
  if (response.status === 400 && code === "validation_error") {
    return new EsveoNotionError({ reason: "invalid_id", message: "Notion does not know this id." });
  }
  return new EsveoNotionError({
    reason: "unexpected",
    message: `Notion answered with status ${response.status}.`,
  });
}

export interface NotionClientOptions {
  /** Spacing between request starts; Notion allows about three per second. */
  readonly minIntervalMs: number;
  readonly maxRetries: number;
}

export const DEFAULT_CLIENT_OPTIONS: NotionClientOptions = { minIntervalMs: 340, maxRetries: 3 };

/** At most three GETs in flight, starts spaced by `minIntervalMs`, 429s retried after Retry-After. */
export const makeNotionGet = Effect.fn("EsveoNotion.makeClient")(function* (
  options: NotionClientOptions,
) {
  const transport = yield* NotionTransport;
  const inFlight = yield* Semaphore.make(3);
  const nextStart = yield* Ref.make(0);
  const send = Effect.fn("EsveoNotion.send")(function* (path: string, secret: string) {
    const now = yield* Clock.currentTimeMillis;
    const wait = yield* Ref.modify(nextStart, (next) => {
      const start = Math.max(now, next);
      return [start - now, start + options.minIntervalMs] as const;
    });
    if (wait > 0) yield* Effect.sleep(wait);
    return yield* transport.get(path, secret);
  }, inFlight.withPermits(1));

  return Effect.fn("EsveoNotion.get")(function* (path: string, secret: string) {
    let attempt = 0;
    while (true) {
      const response = yield* send(path, secret);
      if (response.status !== 429 || attempt >= options.maxRetries) return response;
      attempt += 1;
      yield* Effect.sleep(retryAfterSeconds(response.retryAfter) * 1000);
    }
  });
});
