/**
 * Fork: a read-only Notion page viewer. The environment's server holds the
 * secret of an internal Notion integration and does every Notion request;
 * clients receive a compact render model, never the secret or raw Notion JSON.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";

export const ESVEO_NOTION_WS_METHODS = {
  status: "esveoNotion.status",
  connect: "esveoNotion.connect",
  disconnect: "esveoNotion.disconnect",
  page: "esveoNotion.page",
  pageRefs: "esveoNotion.pageRefs",
  fileUrl: "esveoNotion.fileUrl",
} as const;

export const ESVEO_NOTION_PAGE_REFS_MAX = 50;

export const EsveoNotionStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The integration's (bot user's) name, as Notion's share menu lists it. */
  botName: Schema.NullOr(Schema.String),
  workspaceName: Schema.NullOr(Schema.String),
  /** The secret's last four characters, so the user can tell secrets apart. */
  secretLast4: Schema.NullOr(Schema.String),
  /** A stored secret Notion now rejects (revoked or rotated). */
  secretInvalid: Schema.Boolean,
});
export type EsveoNotionStatus = typeof EsveoNotionStatus.Type;

export const EsveoNotionErrorReason = Schema.Literals([
  "not_connected",
  "unauthorized",
  "not_shared",
  "rate_limited",
  "invalid_id",
  "network",
  "unexpected",
]);
export type EsveoNotionErrorReason = typeof EsveoNotionErrorReason.Type;

export class EsveoNotionError extends Schema.TaggedError<EsveoNotionError>()("EsveoNotionError", {
  reason: EsveoNotionErrorReason,
  message: Schema.String,
  /** The integration a page has to be shared with, for `not_shared`. */
  integrationName: Schema.optionalKey(Schema.String),
  /** Seconds Notion asked to wait, for `rate_limited`. */
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {}

export const EsveoNotionIcon = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
]);
export type EsveoNotionIcon = typeof EsveoNotionIcon.Type;

/** One run of rich text with Notion's annotations; flags are left out when off. */
export const EsveoNotionSpan = Schema.Struct({
  text: Schema.String,
  href: Schema.optionalKey(Schema.String),
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  strikethrough: Schema.optionalKey(Schema.Boolean),
  underline: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.Boolean),
  /** Notion's color name (`red`, `blue_background`, …); absent for `default`. */
  color: Schema.optionalKey(Schema.String),
  mention: Schema.optionalKey(Schema.Literals(["page", "database", "user", "date", "link"])),
  /** The page or database a mention points at, to open it in the viewer. */
  pageId: Schema.optionalKey(Schema.String),
});
export type EsveoNotionSpan = typeof EsveoNotionSpan.Type;

export const EsveoNotionUser = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type EsveoNotionUser = typeof EsveoNotionUser.Type;

export const EsveoNotionOption = Schema.Struct({ name: Schema.String, color: Schema.String });
export type EsveoNotionOption = typeof EsveoNotionOption.Type;

export const EsveoNotionDate = Schema.Struct({
  start: Schema.String,
  end: Schema.NullOr(Schema.String),
});
export type EsveoNotionDate = typeof EsveoNotionDate.Type;

const ScalarValues = [
  Schema.Struct({ kind: Schema.Literal("rich_text"), spans: Schema.Array(EsveoNotionSpan) }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.NullOr(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("number"), number: Schema.NullOr(Schema.Number) }),
  Schema.Struct({
    kind: Schema.Literals(["select", "status"]),
    option: Schema.NullOr(EsveoNotionOption),
  }),
  Schema.Struct({ kind: Schema.Literal("multi_select"), options: Schema.Array(EsveoNotionOption) }),
  Schema.Struct({ kind: Schema.Literal("date"), date: Schema.NullOr(EsveoNotionDate) }),
  Schema.Struct({ kind: Schema.Literal("people"), people: Schema.Array(EsveoNotionUser) }),
  Schema.Struct({ kind: Schema.Literal("checkbox"), checked: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literals(["url", "email", "phone"]),
    value: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("relation"),
    pageIds: Schema.Array(Schema.String),
    hasMore: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("files"),
    files: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        /** Set for external links; uploaded files ask the server for a fresh URL. */
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  /** A Notion property type this viewer does not render. */
  Schema.Struct({ kind: Schema.Literal("unsupported") }),
] as const;

export const EsveoNotionScalarValue = Schema.Union(ScalarValues);
export type EsveoNotionScalarValue = typeof EsveoNotionScalarValue.Type;

export const EsveoNotionPropertyValue = Schema.Union([
  ...ScalarValues,
  Schema.Struct({ kind: Schema.Literal("rollup"), items: Schema.Array(EsveoNotionScalarValue) }),
]);
export type EsveoNotionPropertyValue = typeof EsveoNotionPropertyValue.Type;

export const EsveoNotionProperty = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Notion's property type (`status`, `rollup`, …), for the row's icon. */
  type: Schema.String,
  empty: Schema.Boolean,
  value: EsveoNotionPropertyValue,
});
export type EsveoNotionProperty = typeof EsveoNotionProperty.Type;

export const EsveoNotionBlockType = Schema.Literals([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "callout",
  "quote",
  "code",
  "divider",
  "image",
  "file",
  "bookmark",
  "table",
  "table_row",
  "column_list",
  "column",
  "page",
  "database",
  "synced_block",
  "equation",
  "unsupported",
]);
export type EsveoNotionBlockType = typeof EsveoNotionBlockType.Type;

export interface EsveoNotionBlock {
  readonly id: string;
  readonly type: EsveoNotionBlockType;
  readonly spans?: ReadonlyArray<EsveoNotionSpan>;
  readonly color?: string;
  readonly checked?: boolean;
  readonly toggleable?: boolean;
  readonly icon?: EsveoNotionIcon;
  readonly language?: string;
  readonly caption?: ReadonlyArray<EsveoNotionSpan>;
  /** Image source, external file, bookmark or embed target. */
  readonly url?: string;
  /** Uploaded to Notion: its URL expires, so the client asks `fileUrl` again. */
  readonly hosted?: boolean;
  readonly name?: string;
  /** The page or database a child page, link or database view opens. */
  readonly pageId?: string;
  readonly title?: string;
  readonly expression?: string;
  readonly cells?: ReadonlyArray<ReadonlyArray<EsveoNotionSpan>>;
  readonly columnHeader?: boolean;
  readonly rowHeader?: boolean;
  /** Notion's block type, for `unsupported` and the file/bookmark families. */
  readonly notionType?: string;
  readonly children?: ReadonlyArray<EsveoNotionBlock>;
}

export const EsveoNotionBlock: Schema.Codec<EsveoNotionBlock> = Schema.Struct({
  id: Schema.String,
  type: EsveoNotionBlockType,
  spans: Schema.optionalKey(Schema.Array(EsveoNotionSpan)),
  color: Schema.optionalKey(Schema.String),
  checked: Schema.optionalKey(Schema.Boolean),
  toggleable: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(EsveoNotionIcon),
  language: Schema.optionalKey(Schema.String),
  caption: Schema.optionalKey(Schema.Array(EsveoNotionSpan)),
  url: Schema.optionalKey(Schema.String),
  hosted: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
  pageId: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  expression: Schema.optionalKey(Schema.String),
  cells: Schema.optionalKey(Schema.Array(Schema.Array(EsveoNotionSpan))),
  columnHeader: Schema.optionalKey(Schema.Boolean),
  rowHeader: Schema.optionalKey(Schema.Boolean),
  notionType: Schema.optionalKey(Schema.String),
  children: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<EsveoNotionBlock> => EsveoNotionBlock)),
  ),
});

export const EsveoNotionPageRef = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["page", "database", "workspace"]),
  title: Schema.String,
  icon: Schema.NullOr(EsveoNotionIcon),
  /** False when the integration cannot read it; the title is then a placeholder. */
  accessible: Schema.Boolean,
});
export type EsveoNotionPageRef = typeof EsveoNotionPageRef.Type;

export const EsveoNotionPage = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["page", "database"]),
  url: Schema.String,
  title: Schema.String,
  icon: Schema.NullOr(EsveoNotionIcon),
  /** Ancestors from the top down, ending with the direct parent. */
  breadcrumb: Schema.Array(EsveoNotionPageRef),
  lastEditedTime: Schema.String,
  lastEditedBy: Schema.NullOr(EsveoNotionUser),
  /** Without the title and buttons; filled ones first, each group in Notion's API order. */
  properties: Schema.Array(EsveoNotionProperty),
  blocks: Schema.Array(EsveoNotionBlock),
  /** The page had more blocks than the viewer loads. */
  truncated: Schema.Boolean,
});
export type EsveoNotionPage = typeof EsveoNotionPage.Type;

export const EsveoNotionPageInput = Schema.Struct({
  pageId: Schema.String,
  /** Skip the server's short-lived cache (the reload button). */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type EsveoNotionPageInput = typeof EsveoNotionPageInput.Type;

export const EsveoNotionPageRefsInput = Schema.Struct({
  pageIds: Schema.Array(Schema.String).check(Schema.isMaxLength(ESVEO_NOTION_PAGE_REFS_MAX)),
});
export type EsveoNotionPageRefsInput = typeof EsveoNotionPageRefsInput.Type;

/** A file block, or the `index`th file of a page's files property. */
export const EsveoNotionFileUrlInput = Schema.Union([
  Schema.Struct({ blockId: Schema.String }),
  Schema.Struct({ pageId: Schema.String, propertyId: Schema.String, index: Schema.Number }),
]);
export type EsveoNotionFileUrlInput = typeof EsveoNotionFileUrlInput.Type;

export const EsveoNotionConnectInput = Schema.Struct({
  secret: Schema.String.check(Schema.isMaxLength(512)),
});
export type EsveoNotionConnectInput = typeof EsveoNotionConnectInput.Type;

const errors = Schema.Union([EsveoNotionError, EnvironmentAuthorizationError]);

export const WsEsveoNotionStatusRpc = Rpc.make(ESVEO_NOTION_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: EsveoNotionStatus,
  error: errors,
});

export const WsEsveoNotionConnectRpc = Rpc.make(ESVEO_NOTION_WS_METHODS.connect, {
  payload: EsveoNotionConnectInput,
  success: EsveoNotionStatus,
  error: errors,
});

export const WsEsveoNotionDisconnectRpc = Rpc.make(ESVEO_NOTION_WS_METHODS.disconnect, {
  payload: Schema.Struct({}),
  success: EsveoNotionStatus,
  error: errors,
});

export const WsEsveoNotionPageRpc = Rpc.make(ESVEO_NOTION_WS_METHODS.page, {
  payload: EsveoNotionPageInput,
  success: EsveoNotionPage,
  error: errors,
});

export const WsEsveoNotionPageRefsRpc = Rpc.make(ESVEO_NOTION_WS_METHODS.pageRefs, {
  payload: EsveoNotionPageRefsInput,
  success: Schema.Array(EsveoNotionPageRef),
  error: errors,
});

export const WsEsveoNotionFileUrlRpc = Rpc.make(ESVEO_NOTION_WS_METHODS.fileUrl, {
  payload: EsveoNotionFileUrlInput,
  success: Schema.Struct({ url: Schema.String }),
  error: errors,
});

const NOTION_HOSTS = /^(?:www\.)?notion\.(?:so|com)$|^app\.notion\.com$|\.notion\.site$/i;
const UUID_HEX = /[0-9a-f]{32}$/i;

const formatUuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();

/** A page id as a dashed lowercase UUID, from a bare id (with or without dashes). */
export function normalizeNotionId(value: string): string | null {
  const hex = value.trim().replaceAll("-", "");
  return /^[0-9a-f]{32}$/i.test(hex) ? formatUuid(hex) : null;
}

/**
 * The page (or database) a Notion link opens: `notion.so/<ws>/<Title>-<id>`,
 * `app.notion.com/p/<id>`, `<ws>.notion.site/<id>`, and a peeked page's `?p=`.
 * Null for anything else, such as Notion's own settings pages.
 */
export function parseNotionPageUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!NOTION_HOSTS.test(url.hostname)) return null;
  const peeked = url.searchParams.get("p");
  if (peeked !== null) {
    const id = normalizeNotionId(peeked);
    if (id !== null) return id;
  }
  const segment = url.pathname.split("/").findLast((part) => part.length > 0) ?? "";
  const match = UUID_HEX.exec(decodeURIComponent(segment).replaceAll("-", ""));
  return match === null ? null : formatUuid(match[0]);
}

/** The Notion URL that opens a page by id. */
export const notionPageUrl = (pageId: string) =>
  `https://www.notion.so/${pageId.replaceAll("-", "")}`;
