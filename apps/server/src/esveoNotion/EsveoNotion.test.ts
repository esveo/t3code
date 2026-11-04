import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  clientRpcRequiredScopes,
  ESVEO_NOTION_WS_METHODS,
  type EsveoNotionError,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { EsveoNotion, makeWith, NOTION_SECRET_NAME } from "./EsveoNotion.ts";
import fixtures from "./fixtures/notionResponses.json" with { type: "json" };
import { NotionTransport, type NotionResponse, toNotionError } from "./notionApi.ts";

const SECRET = "ntn_fixture_secret_1234";
const PAGE_ID = fixtures.page.id;
const DATABASE_ID = fixtures.db.id;

const ok = (body: unknown): NotionResponse => ({ status: 200, retryAfter: undefined, body });
const notFound: NotionResponse = { status: 404, retryAfter: undefined, body: fixtures.nf };
const unauthorized: NotionResponse = { status: 401, retryAfter: undefined, body: fixtures.unauth };
const tooMany: NotionResponse = {
  status: 429,
  retryAfter: "2",
  body: { object: "error", status: 429, code: "rate_limited", message: "" },
};

/** Recorded Notion answers by path; a queue per path plays its answers in order. */
function setup(routes: Record<string, NotionResponse | NotionResponse[]>, stored?: string) {
  const store = new Map<string, Uint8Array>();
  if (stored !== undefined) store.set(NOTION_SECRET_NAME, new TextEncoder().encode(stored));
  const requests: string[] = [];
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
    set: (name, value) => Effect.sync(() => void store.set(name, value)),
    create: (name, value) => Effect.sync(() => void store.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void store.delete(name)),
  });
  const transport = NotionTransport.of({
    get: (path, secret) =>
      Effect.sync(() => {
        requests.push(path);
        const route = routes[path.split("?")[0]!];
        const answer = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
        if (secret !== SECRET) return unauthorized;
        return answer ?? notFound;
      }),
  });
  const layer = Layer.effect(EsveoNotion, makeWith({ minIntervalMs: 0, maxRetries: 2 })).pipe(
    Layer.provide(Layer.succeed(ServerSecretStore, secrets)),
    Layer.provide(Layer.succeed(NotionTransport, transport)),
  );
  return { store, requests, layer };
}

const PAGE_ROUTES = {
  "/users/me": ok(fixtures.me),
  [`/pages/${PAGE_ID}`]: ok(fixtures.page),
  [`/blocks/${PAGE_ID}/children`]: ok(fixtures.children),
  [`/blocks/${fixtures.children.results[2]!.id}/children`]: ok(fixtures.toggle1),
  [`/blocks/${fixtures.children.results[3]!.id}/children`]: ok({ results: [], has_more: false }),
  [`/blocks/${fixtures.children.results[4]!.id}/children`]: ok({ results: [], has_more: false }),
  [`/databases/${DATABASE_ID}`]: ok(fixtures.db),
  [`/users/${fixtures.page.last_edited_by.id}`]: ok({
    object: "user",
    id: fixtures.page.last_edited_by.id,
    name: "Person 9",
    avatar_url: null,
  }),
};

const flipError = <A, R>(effect: Effect.Effect<A, EsveoNotionError, R>) => Effect.flip(effect);

describe("EsveoNotion connect", () => {
  it.effect("stores a secret only after Notion accepts it and never returns it", () => {
    const { store, layer } = setup({ "/users/me": ok(fixtures.me) });
    return Effect.gen(function* () {
      const notion = yield* EsveoNotion;
      const rejected = yield* flipError(notion.connect("ntn_wrong_secret_0000"));
      assert.strictEqual(rejected.reason, "unauthorized");
      assert.isFalse(store.has(NOTION_SECRET_NAME));

      const status = yield* notion.connect(` ${SECRET} `);
      assert.deepStrictEqual(status, {
        connected: true,
        botName: "test",
        workspaceName: "Workspace",
        secretLast4: "1234",
        secretInvalid: false,
      });
      assert.notInclude(JSON.stringify(status), SECRET);
      assert.strictEqual(new TextDecoder().decode(store.get(NOTION_SECRET_NAME)), SECRET);

      assert.deepStrictEqual(yield* notion.disconnect(), {
        connected: false,
        botName: null,
        workspaceName: null,
        secretLast4: null,
        secretInvalid: false,
      });
      assert.isFalse(store.has(NOTION_SECRET_NAME));
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a stored secret Notion now rejects", () => {
    const { layer } = setup({}, "ntn_revoked_secret_9999");
    return Effect.gen(function* () {
      const status = yield* (yield* EsveoNotion).status();
      assert.isTrue(status.connected);
      assert.isTrue(status.secretInvalid);
      assert.strictEqual(status.secretLast4, "9999");
    }).pipe(Effect.provide(layer));
  });
});

describe("EsveoNotion page", () => {
  it.effect(
    "loads the page with its properties, toggle children and breadcrumb, then caches it",
    () => {
      const { requests, layer } = setup(PAGE_ROUTES, SECRET);
      return Effect.gen(function* () {
        const notion = yield* EsveoNotion;
        const page = yield* notion.page({ pageId: PAGE_ID.replaceAll("-", "") });
        assert.strictEqual(page.kind, "page");
        assert.strictEqual(page.title, "Text 1");
        assert.deepStrictEqual(page.icon, { kind: "emoji", emoji: fixtures.page.icon.emoji });
        assert.strictEqual(page.lastEditedBy?.name, "Person 9");
        assert.isFalse(page.truncated);
        assert.strictEqual(page.blocks[2]?.children?.[0]?.type, "file");
        // The database is readable; its parent page is not shared, so the walk stops there.
        assert.deepStrictEqual(
          page.breadcrumb.map((crumb) => [crumb.kind, crumb.title, crumb.accessible]),
          [
            ["page", "Kein Zugriff", false],
            ["database", "Text 11", true],
          ],
        );

        const count = requests.length;
        yield* notion.page({ pageId: PAGE_ID });
        assert.strictEqual(requests.length, count);
        yield* notion.page({ pageId: PAGE_ID, refresh: true });
        assert.isAbove(requests.length, count);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("opens a database id through the database endpoint", () => {
    const { layer } = setup(
      {
        [`/pages/${DATABASE_ID}`]: {
          status: 400,
          retryAfter: undefined,
          body: {
            object: "error",
            code: "validation_error",
            message: `Provided ID ${DATABASE_ID} is a database, not a page. Use the retrieve database API instead.`,
          },
        },
        [`/databases/${DATABASE_ID}`]: ok(fixtures.db),
      },
      SECRET,
    );
    return Effect.gen(function* () {
      const page = yield* (yield* EsveoNotion).page({ pageId: DATABASE_ID });
      assert.strictEqual(page.kind, "database");
      assert.strictEqual(page.title, "Text 11");
      assert.deepStrictEqual(page.properties, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the integration when a page is not shared with it", () => {
    const { layer } = setup({ "/users/me": ok(fixtures.me) }, SECRET);
    return Effect.gen(function* () {
      const error = yield* flipError((yield* EsveoNotion).page({ pageId: PAGE_ID }));
      assert.strictEqual(error.reason, "not_shared");
      assert.strictEqual(error.integrationName, "test");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails without a connected integration and for ids that are not Notion's", () => {
    const { layer, requests } = setup(PAGE_ROUTES);
    return Effect.gen(function* () {
      const notion = yield* EsveoNotion;
      assert.strictEqual(
        (yield* flipError(notion.page({ pageId: PAGE_ID }))).reason,
        "not_connected",
      );
      assert.strictEqual((yield* flipError(notion.page({ pageId: "nope" }))).reason, "invalid_id");
      assert.deepStrictEqual(requests, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("waits out Notion's Retry-After and tries again", () => {
    const { layer, requests } = setup(
      { ...PAGE_ROUTES, [`/pages/${PAGE_ID}`]: [tooMany, ok(fixtures.page)] },
      SECRET,
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* EsveoNotion).page({ pageId: PAGE_ID }));
      yield* TestClock.adjust("2 seconds");
      const page = yield* Fiber.join(fiber);
      assert.strictEqual(page.title, "Text 1");
      assert.strictEqual(requests.filter((path) => path === `/pages/${PAGE_ID}`).length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves relation titles and marks unreadable ones", () => {
    const related = fixtures.rel.id;
    const { layer } = setup({ [`/pages/${related}`]: ok(fixtures.rel) }, SECRET);
    return Effect.gen(function* () {
      const refs = yield* (yield* EsveoNotion).pageRefs({ pageIds: [related, PAGE_ID] });
      assert.deepStrictEqual(
        refs.map((ref) => ref.accessible),
        [true, false],
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("Notion errors", () => {
  it("maps 401, 404 and 429 to the viewer's reasons", () => {
    assert.strictEqual(toNotionError(unauthorized, null).reason, "unauthorized");
    const notShared = toNotionError(notFound, "test");
    assert.strictEqual(notShared.reason, "not_shared");
    assert.strictEqual(notShared.integrationName, "test");
    const limited = toNotionError(tooMany, null);
    assert.strictEqual(limited.reason, "rate_limited");
    assert.strictEqual(limited.retryAfterSeconds, 2);
    assert.strictEqual(
      toNotionError({ status: 400, retryAfter: undefined, body: fixtures.bad }, null).reason,
      "invalid_id",
    );
  });
});

it("reads Notion with orchestration read and changes the secret with settings write", () => {
  for (const method of [
    ESVEO_NOTION_WS_METHODS.status,
    ESVEO_NOTION_WS_METHODS.page,
    ESVEO_NOTION_WS_METHODS.pageRefs,
    ESVEO_NOTION_WS_METHODS.fileUrl,
  ]) {
    assert.strictEqual(requiredScopeForRpcMethod(method), AuthOrchestrationReadScope);
  }
  for (const method of [ESVEO_NOTION_WS_METHODS.connect, ESVEO_NOTION_WS_METHODS.disconnect]) {
    assert.strictEqual(requiredScopeForRpcMethod(method), AuthSettingsWriteScope);
    assert.deepStrictEqual(clientRpcRequiredScopes(method, undefined), [AuthSettingsWriteScope]);
  }
});
