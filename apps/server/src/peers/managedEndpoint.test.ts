import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readManagedEndpoint, rememberManagedEndpoint } from "./managedEndpoint.ts";

const memorySecrets = () => {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name: string) => Effect.succeed(Option.fromNullishOr(values.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void values.set(name, value)),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"]);
};

it.effect("keeps the tunnel's address and ignores a local one", () => {
  const secrets = memorySecrets();
  return Effect.gen(function* () {
    yield* rememberManagedEndpoint(secrets, {
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      providerKind: "manual",
    });
    assert.isNull(yield* readManagedEndpoint);
    yield* rememberManagedEndpoint(secrets, {
      httpBaseUrl: "https://abc.t3.example/",
      wsBaseUrl: "wss://abc.t3.example/",
      providerKind: "cloudflare_tunnel",
    });
    assert.strictEqual(yield* readManagedEndpoint, "https://abc.t3.example");
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets));
});
