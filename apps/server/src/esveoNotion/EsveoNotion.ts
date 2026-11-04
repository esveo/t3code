/**
 * Fork: the Notion page viewer's server side. The environment keeps one
 * internal-integration secret in its secret store; every Notion request runs
 * here so web, desktop and remote clients behave the same and never see it.
 */
import {
  EsveoNotionError,
  type EsveoNotionBlock,
  type EsveoNotionFileUrlInput,
  type EsveoNotionPage,
  type EsveoNotionPageInput,
  type EsveoNotionPageRef,
  type EsveoNotionPageRefsInput,
  type EsveoNotionStatus,
  type EsveoNotionProperty,
  type EsveoNotionUser,
  normalizeNotionId,
  notionPageUrl,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  DEFAULT_CLIENT_OPTIONS,
  httpTransport,
  isDatabaseIdError,
  makeNotionGet,
  type NotionClientOptions,
  type NotionResponse,
  toNotionError,
} from "./notionApi.ts";
import {
  fileObjectUrl,
  type Json,
  LEAF_BLOCKS,
  type NotionParent,
  parentOf,
  toBlock,
  toIcon,
  toPageRef,
  toProperties,
  toSpans,
  toUser,
  titleOf,
} from "./notionRenderModel.ts";

export const NOTION_SECRET_NAME = "esveo-notion-integration";

const PAGE_CACHE_MS = 60_000;
const REF_CACHE_MS = 10 * 60_000;
const CACHE_ENTRIES = 200;
const BREADCRUMB_LEVELS = 6;
const MAX_BLOCKS = 1_000;
const MAX_DEPTH = 6;

export class EsveoNotion extends Context.Service<
  EsveoNotion,
  {
    readonly status: () => Effect.Effect<EsveoNotionStatus, EsveoNotionError>;
    readonly connect: (secret: string) => Effect.Effect<EsveoNotionStatus, EsveoNotionError>;
    readonly disconnect: () => Effect.Effect<EsveoNotionStatus, EsveoNotionError>;
    readonly page: (
      input: EsveoNotionPageInput,
    ) => Effect.Effect<EsveoNotionPage, EsveoNotionError>;
    readonly pageRefs: (
      input: EsveoNotionPageRefsInput,
    ) => Effect.Effect<ReadonlyArray<EsveoNotionPageRef>, EsveoNotionError>;
    readonly fileUrl: (
      input: EsveoNotionFileUrlInput,
    ) => Effect.Effect<{ readonly url: string }, EsveoNotionError>;
  }
>()("t3/esveoNotion/EsveoNotion") {}

interface Identity {
  readonly secret: string;
  readonly botName: string | null;
  readonly workspaceName: string | null;
}

const DISCONNECTED: EsveoNotionStatus = {
  connected: false,
  botName: null,
  workspaceName: null,
  secretLast4: null,
  secretInvalid: false,
};

const fail = (reason: EsveoNotionError["reason"], message: string) =>
  new EsveoNotionError({ reason, message });

const storeFailure = () => fail("unexpected", "The server's secret store failed.");

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asJson = (value: unknown): Json => (isJson(value) ? value : {});

/** A tiny time-bounded cache; the oldest entry goes when it is full. */
const makeCache = <A>(ttlMs: number) => {
  const entries = new Map<string, { readonly at: number; readonly value: A }>();
  return {
    get: (key: string, now: number): A | undefined => {
      const entry = entries.get(key);
      if (entry === undefined || now - entry.at > ttlMs) return undefined;
      return entry.value;
    },
    set: (key: string, now: number, value: A) => {
      entries.delete(key);
      entries.set(key, { at: now, value });
      if (entries.size > CACHE_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    clear: () => entries.clear(),
  };
};

interface ResolvedRef {
  /** Null for a block, which is only a step towards its page. */
  readonly ref: EsveoNotionPageRef | null;
  readonly parent: NotionParent;
}

const inaccessibleRef = (id: string, kind: EsveoNotionPageRef["kind"]): EsveoNotionPageRef => ({
  id,
  kind,
  title: "Kein Zugriff",
  icon: null,
  accessible: false,
});

export const makeWith = Effect.fn("EsveoNotion.make")(function* (options: NotionClientOptions) {
  const secrets = yield* ServerSecretStore;
  const notionGet = yield* makeNotionGet(options);
  const identity = yield* Ref.make<Identity | null>(null);
  const pages = makeCache<EsveoNotionPage>(PAGE_CACHE_MS);
  const refs = makeCache<ResolvedRef>(REF_CACHE_MS);
  const users = makeCache<EsveoNotionUser>(REF_CACHE_MS);

  const clearCaches = () => {
    pages.clear();
    refs.clear();
    users.clear();
  };

  const storedSecret = secrets
    .get(NOTION_SECRET_NAME)
    .pipe(
      Effect.mapError(storeFailure),
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    );

  const requireSecret = Effect.flatMap(storedSecret, (secret) =>
    Effect.fromOption(secret, () => fail("not_connected", "No Notion integration is connected.")),
  );

  /** GET /users/me: the integration (a bot user) and its workspace. */
  const fetchIdentity = Effect.fn("EsveoNotion.fetchIdentity")(function* (secret: string) {
    const response = yield* notionGet("/users/me", secret);
    if (response.status !== 200) return yield* toNotionError(response, null);
    const body = asJson(response.body);
    if (body.type !== "bot") {
      return yield* fail("unauthorized", "The secret does not belong to an integration.");
    }
    const workspaceName = asJson(body.bot).workspace_name;
    const found: Identity = {
      secret,
      botName: typeof body.name === "string" ? body.name : null,
      workspaceName: typeof workspaceName === "string" ? workspaceName : null,
    };
    yield* Ref.set(identity, found);
    return found;
  });

  const cachedIdentity = (secret: string) =>
    Ref.get(identity).pipe(
      Effect.filterOrElse(
        (known): known is Identity => known !== null && known.secret === secret,
        () => fetchIdentity(secret),
      ),
    );

  const connectedStatus = (found: Identity): EsveoNotionStatus => ({
    connected: true,
    botName: found.botName,
    workspaceName: found.workspaceName,
    secretLast4: found.secret.slice(-4),
    secretInvalid: false,
  });

  /** The viewer's error for a failed response; a missing page names the integration to share with. */
  const failure = Effect.fn("EsveoNotion.failure")(function* (
    response: NotionResponse,
    secret: string,
  ) {
    const integrationName =
      response.status === 404 || response.status === 403
        ? yield* cachedIdentity(secret).pipe(
            Effect.map((found) => found.botName),
            Effect.orElseSucceed(() => null),
          )
        : null;
    return yield* toNotionError(response, integrationName);
  });

  /** A Notion GET that fails with the viewer's error for anything but 200. */
  const get = Effect.fn("EsveoNotion.request")(function* (path: string) {
    const secret = yield* requireSecret;
    const response = yield* notionGet(path, secret);
    if (response.status === 200) return asJson(response.body);
    return yield* failure(response, secret);
  });

  const requireId = (value: string) => {
    const id = normalizeNotionId(value);
    return id === null
      ? Effect.fail(fail("invalid_id", "This is not a Notion page id."))
      : Effect.succeed(id);
  };

  /** A page, or the database a page id turns out to be. */
  const fetchPageOrDatabase = Effect.fn("EsveoNotion.fetchPageOrDatabase")(function* (id: string) {
    const secret = yield* requireSecret;
    const response = yield* notionGet(`/pages/${id}`, secret);
    if (response.status === 200) return asJson(response.body);
    if (isDatabaseIdError(response)) return yield* get(`/databases/${id}`);
    return yield* failure(response, secret);
  });

  const resolveRef = Effect.fn("EsveoNotion.resolveRef")(function* (parent: NotionParent) {
    if (parent.kind === "workspace") return null;
    const key = `${parent.kind}:${parent.id}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = refs.get(key, now);
    if (cached !== undefined) return cached;
    const path =
      parent.kind === "database"
        ? `/databases/${parent.id}`
        : parent.kind === "block"
          ? `/blocks/${parent.id}`
          : `/pages/${parent.id}`;
    const resolved: ResolvedRef = yield* get(path).pipe(
      Effect.map((raw): ResolvedRef => ({
        ref: parent.kind === "block" ? null : toPageRef(raw),
        parent: parentOf(raw),
      })),
      Effect.catchIf(
        (error) => error.reason === "not_shared",
        () =>
          Effect.succeed<ResolvedRef>({
            ref: parent.kind === "block" ? null : inaccessibleRef(parent.id, parent.kind),
            parent: { kind: "workspace" },
          }),
      ),
    );
    refs.set(key, now, resolved);
    return resolved;
  });

  /** Ancestors from the top down; stops at the workspace, a page it cannot read, or the cap. */
  const breadcrumb = Effect.fn("EsveoNotion.breadcrumb")(function* (start: NotionParent) {
    const crumbs: EsveoNotionPageRef[] = [];
    let parent = start;
    // Blocks are steps, not crumbs, so the walk allows a few more of them.
    for (let step = 0; step < BREADCRUMB_LEVELS * 2 && crumbs.length < BREADCRUMB_LEVELS; step++) {
      const resolved = yield* resolveRef(parent).pipe(Effect.orElseSucceed(() => null));
      if (resolved === null) break;
      if (resolved.ref !== null) crumbs.push(resolved.ref);
      parent = resolved.parent;
    }
    if (parent.kind !== "workspace" && crumbs.length === BREADCRUMB_LEVELS) {
      crumbs.push({ id: "", kind: "workspace", title: "…", icon: null, accessible: false });
    }
    return crumbs.reverse();
  });

  /**
   * Names of the editor; Notion only sends the id on a page. The page's own
   * people properties usually name them, which matters because a personal
   * access token may only look up its own user.
   */
  const resolveUser = Effect.fn("EsveoNotion.resolveUser")(function* (
    raw: unknown,
    known: ReadonlyArray<EsveoNotionUser>,
  ) {
    const user = toUser(raw);
    if (user === null || user.name !== null) return user;
    const named = known.find((candidate) => candidate.id === user.id && candidate.name !== null);
    if (named !== undefined) return named;
    const now = yield* Clock.currentTimeMillis;
    const cached = users.get(user.id, now);
    if (cached !== undefined) return cached;
    const resolved = yield* get(`/users/${user.id}`).pipe(
      Effect.map((body) => toUser(body) ?? user),
      Effect.orElseSucceed(() => user),
    );
    users.set(user.id, now, resolved);
    return resolved;
  });

  const fetchChildren = Effect.fn("EsveoNotion.fetchChildren")(function* (blockId: string) {
    const results: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`;
      const body = yield* get(`/blocks/${blockId}/children?page_size=100${query}`);
      results.push(...(Array.isArray(body.results) ? body.results : []));
      cursor =
        body.has_more === true && typeof body.next_cursor === "string" ? body.next_cursor : null;
    } while (cursor !== null && results.length < MAX_BLOCKS);
    return { results, more: cursor !== null };
  });

  /** The block tree below a page; toggles' children too, so expanding needs no request. */
  const blockTree = Effect.fn("EsveoNotion.blockTree")(function* (pageId: string) {
    const loaded = yield* Ref.make(0);
    const truncated = yield* Ref.make(false);

    // Untraced: one call per nested block list, all inside blockTree's span.
    const level: (
      parentId: string,
      depth: number,
    ) => Effect.Effect<ReadonlyArray<EsveoNotionBlock>, EsveoNotionError> = Effect.fnUntraced(
      function* (parentId: string, depth: number) {
        const { results, more } = yield* fetchChildren(parentId);
        const room = MAX_BLOCKS - (yield* Ref.getAndUpdate(loaded, (n) => n + results.length));
        if (more || room < results.length) yield* Ref.set(truncated, true);
        const kept = results.slice(0, Math.max(0, room));
        return yield* Effect.forEach(
          kept,
          (raw) => {
            const block = asJson(raw);
            const type = typeof block.type === "string" ? block.type : "";
            const descend =
              block.has_children === true && !LEAF_BLOCKS.has(type) && typeof block.id === "string";
            if (!descend) return Effect.succeed(toBlock(block));
            if (depth >= MAX_DEPTH) {
              return Ref.set(truncated, true).pipe(Effect.as(toBlock(block)));
            }
            return Effect.map(level(block.id as string, depth + 1), (children) =>
              toBlock(block, children),
            );
          },
          { concurrency: 3 },
        );
      },
    );

    const blocks = yield* level(pageId, 1);
    return { blocks, truncated: yield* Ref.get(truncated) };
  });

  const loadPage = Effect.fn("EsveoNotion.loadPage")(function* (id: string) {
    const raw = yield* fetchPageOrDatabase(id);
    const isDatabase = raw.object === "database";
    const properties = isDatabase ? [] : toProperties(raw.properties);
    const [tree, crumbs, editor] = yield* Effect.all(
      [
        isDatabase
          ? Effect.succeed({ blocks: databaseDescription(raw), truncated: false })
          : blockTree(id),
        breadcrumb(parentOf(raw)),
        resolveUser(raw.last_edited_by, propertyPeople(properties)),
      ],
      { concurrency: 3 },
    );
    const page: EsveoNotionPage = {
      id,
      kind: isDatabase ? "database" : "page",
      url: typeof raw.url === "string" ? raw.url : notionPageUrl(id),
      title: titleOf(raw) || "Unbenannt",
      icon: toIcon(raw.icon),
      breadcrumb: crumbs,
      lastEditedTime: typeof raw.last_edited_time === "string" ? raw.last_edited_time : "",
      lastEditedBy: editor,
      properties,
      blocks: tree.blocks,
      truncated: tree.truncated,
    };
    return page;
  });

  const status: EsveoNotion["Service"]["status"] = Effect.fn("EsveoNotion.status")(function* () {
    const secret = yield* storedSecret;
    if (Option.isNone(secret)) return DISCONNECTED;
    return yield* cachedIdentity(secret.value).pipe(
      Effect.map(connectedStatus),
      Effect.catch((error) =>
        Effect.succeed<EsveoNotionStatus>({
          connected: true,
          botName: null,
          workspaceName: null,
          secretLast4: secret.value.slice(-4),
          secretInvalid: error.reason === "unauthorized",
        }),
      ),
    );
  });

  const connect: EsveoNotion["Service"]["connect"] = Effect.fn("EsveoNotion.connect")(
    function* (input) {
      const secret = input.trim();
      if (secret.length < 8 || /\s/.test(secret)) {
        return yield* fail("unauthorized", "This does not look like an integration secret.");
      }
      const found = yield* fetchIdentity(secret);
      yield* secrets
        .set(NOTION_SECRET_NAME, new TextEncoder().encode(secret))
        .pipe(Effect.mapError(storeFailure));
      clearCaches();
      return connectedStatus(found);
    },
  );

  const disconnect: EsveoNotion["Service"]["disconnect"] = Effect.fn("EsveoNotion.disconnect")(
    function* () {
      yield* secrets.remove(NOTION_SECRET_NAME).pipe(Effect.mapError(storeFailure));
      yield* Ref.set(identity, null);
      clearCaches();
      return DISCONNECTED;
    },
  );

  const page: EsveoNotion["Service"]["page"] = Effect.fn("EsveoNotion.page")(function* (input) {
    const id = yield* requireId(input.pageId);
    const now = yield* Clock.currentTimeMillis;
    const cached = input.refresh === true ? undefined : pages.get(id, now);
    if (cached !== undefined) return cached;
    const loaded = yield* loadPage(id);
    pages.set(id, now, loaded);
    return loaded;
  });

  const pageRefs: EsveoNotion["Service"]["pageRefs"] = Effect.fn("EsveoNotion.pageRefs")(
    function* (input) {
      yield* requireSecret;
      return yield* Effect.forEach(
        input.pageIds,
        (pageId) => {
          const id = normalizeNotionId(pageId);
          if (id === null) return Effect.succeed(inaccessibleRef(pageId, "page"));
          return resolveRef({ kind: "page", id }).pipe(
            Effect.catchIf(
              (error) => error.reason === "invalid_id",
              () => resolveRef({ kind: "database", id }),
            ),
            Effect.map((resolved) => resolved?.ref ?? inaccessibleRef(id, "page")),
          );
        },
        { concurrency: 3 },
      );
    },
  );

  const fileUrl: EsveoNotion["Service"]["fileUrl"] = Effect.fn("EsveoNotion.fileUrl")(
    function* (input) {
      const notFound = fail("unexpected", "Notion has no file there.");
      if ("blockId" in input) {
        const id = yield* requireId(input.blockId);
        const block = yield* get(`/blocks/${id}`);
        const source = typeof block.type === "string" ? fileObjectUrl(block[block.type]) : null;
        if (source === null) return yield* notFound;
        return { url: source.url };
      }
      const id = yield* requireId(input.pageId);
      const item = yield* get(`/pages/${id}/properties/${encodeURIComponent(input.propertyId)}`);
      const files = Array.isArray(item.files) ? item.files : [];
      const source = fileObjectUrl(files[input.index]);
      if (source === null) return yield* notFound;
      return { url: source.url };
    },
  );

  return EsveoNotion.of({ status, connect, disconnect, page, pageRefs, fileUrl });
});

/** Users named by the page's people, created-by and last-edited-by properties. */
const propertyPeople = (properties: ReadonlyArray<EsveoNotionProperty>) =>
  properties.flatMap((property) => (property.value.kind === "people" ? property.value.people : []));

/** A database has no blocks; its description stands in as the first paragraph. */
function databaseDescription(raw: Json): EsveoNotionBlock[] {
  const spans = toSpans(raw.description);
  return spans.length === 0
    ? []
    : [{ id: `${String(raw.id)}:description`, type: "paragraph", spans }];
}

export const layer = Layer.effect(EsveoNotion, makeWith(DEFAULT_CLIENT_OPTIONS)).pipe(
  Layer.provide(httpTransport),
);

/** Read optionally, like ForkInstructions, so server tests that build the RPC layer need not provide it. */
const withService = <A>(
  use: (service: EsveoNotion["Service"]) => Effect.Effect<A, EsveoNotionError>,
): Effect.Effect<A, EsveoNotionError> =>
  Effect.flatMap(Effect.serviceOption(EsveoNotion), (service) =>
    Option.isSome(service)
      ? use(service.value)
      : Effect.fail(fail("unexpected", "This server has no Notion viewer.")),
  );

export const statusRpc = () => withService((service) => service.status());
export const connectRpc = (input: { readonly secret: string }) =>
  withService((service) => service.connect(input.secret));
export const disconnectRpc = () => withService((service) => service.disconnect());
export const pageRpc = (input: EsveoNotionPageInput) =>
  withService((service) => service.page(input));
export const pageRefsRpc = (input: EsveoNotionPageRefsInput) =>
  withService((service) => service.pageRefs(input));
export const fileUrlRpc = (input: EsveoNotionFileUrlInput) =>
  withService((service) => service.fileUrl(input));
