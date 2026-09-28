/**
 * Fork: the routes other environments call. They sit outside environment
 * authentication on purpose: a contact holds no environment session, only
 * the invite secret (to link) or its contact token (to deliver), and these
 * routes grant nothing beyond that.
 */
import { PEERS_HTTP_PREFIX, PeerDeliverRequest, PeerRedeemRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as Peers from "./Peers.ts";

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });

const redeem = Effect.gen(function* () {
  const request = yield* HttpServerRequest.schemaBodyJson(PeerRedeemRequest).pipe(Effect.option);
  if (Option.isNone(request)) return text("Bad Request", 400);
  const answer = yield* Peers.withService((peers) => peers.acceptRedeem(request.value)).pipe(
    Effect.option,
  );
  if (Option.isNone(answer)) return text("Not Found", 404);
  return Option.isSome(answer.value)
    ? HttpServerResponse.jsonUnsafe(answer.value.value)
    : text("Forbidden", 403);
});

const deliver = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return text("Unauthorized", 401);
  const body = yield* HttpServerRequest.schemaBodyJson(PeerDeliverRequest).pipe(Effect.option);
  if (Option.isNone(body)) return text("Bad Request", 400);
  const accepted = yield* Peers.withService((peers) => peers.receive(token, body.value)).pipe(
    Effect.option,
  );
  if (Option.isNone(accepted)) return text("Service Unavailable", 503);
  return accepted.value ? HttpServerResponse.jsonUnsafe({ ok: true }) : text("Unauthorized", 401);
});

export const peersRouteLayer = Layer.mergeAll(
  HttpRouter.add("POST", `${PEERS_HTTP_PREFIX}/redeem`, redeem),
  HttpRouter.add("POST", `${PEERS_HTTP_PREFIX}/messages`, deliver),
);
