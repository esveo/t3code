/**
 * Fork: the address T3 Connect gives this environment, for Peers. The relay
 * names it when the server links, and lists it for the account the server is
 * linked with, but upstream keeps nothing of it. Peers offers it as this
 * environment's address, so nobody has to look up their tunnel's hostname.
 */
import { type RelayManagedEndpoint, RelayListEnvironmentsResponse } from "@t3tools/contracts/relay";
import { normalizePeerBaseUrl } from "@t3tools/shared/peers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const SECRET_NAME = "fork-peers-managed-endpoint";

/** Keeps a public tunnel address; a loopback or manual endpoint is none. */
export const rememberManagedEndpoint = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  endpoint: RelayManagedEndpoint,
) => {
  const url =
    endpoint.providerKind === "cloudflare_tunnel"
      ? normalizePeerBaseUrl(endpoint.httpBaseUrl)
      : null;
  return url
    ? secrets.set(SECRET_NAME, new TextEncoder().encode(url)).pipe(Effect.ignore)
    : Effect.void;
};

/** The remembered address, or null when this environment has no T3 Connect tunnel. */
export const readManagedEndpoint = Effect.gen(function* () {
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  if (Option.isNone(secrets)) return null;
  const stored = yield* secrets.value
    .get(SECRET_NAME)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(stored) ? new TextDecoder().decode(stored.value) : null;
});

/**
 * Asks the relay for this environment's address with the account token
 * `t3 connect` stored, and remembers it. The server reuses its tunnel on a
 * normal start without linking again, so the link response alone may never
 * come. Null when the server is not linked or the relay cannot be reached.
 */
export const lookupManagedEndpoint = Effect.gen(function* () {
  const tokens = yield* Effect.serviceOption(CliTokenManager.CloudCliTokenManager);
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (
    Option.isNone(tokens) ||
    Option.isNone(secrets) ||
    Option.isNone(environment) ||
    Option.isNone(httpClient)
  ) {
    return null;
  }
  const token = yield* tokens.value.getExisting;
  if (Option.isNone(token)) return null;
  const relayUrl = yield* relayUrlConfig;
  const environmentId = yield* environment.value.getEnvironmentId;
  const listed = yield* httpClient.value
    .execute(
      HttpClientRequest.get(`${relayUrl}/v1/environments`).pipe(
        HttpClientRequest.bearerToken(token.value.accessToken),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayListEnvironmentsResponse)),
    );
  const own = listed.environments.find((entry) => entry.environmentId === environmentId);
  if (!own) return null;
  yield* rememberManagedEndpoint(secrets.value, own.endpoint);
  return yield* readManagedEndpoint;
}).pipe(
  Effect.timeout("10 seconds"),
  Effect.catchCause((cause) =>
    Effect.as(Effect.logDebug("peers: could not look up the T3 Connect address", cause), null),
  ),
);
