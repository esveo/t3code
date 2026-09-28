/**
 * Fork: the address T3 Connect gives this environment, for Peers. The relay
 * names it in every link response (the server links again on each start),
 * but upstream keeps nothing of it. Peers offers it as this environment's
 * address, so nobody has to look up their tunnel's hostname.
 */
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { normalizePeerBaseUrl } from "@t3tools/shared/peers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

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
