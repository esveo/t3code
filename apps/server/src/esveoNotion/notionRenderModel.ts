/**
 * Fork: turns Notion API JSON (version 2022-06-28) into the viewer's render
 * model. Pure and defensive: Notion adds block and property types over time, and
 * anything unknown becomes an `unsupported` entry instead of a failure.
 */
import type {
  EsveoNotionBlock,
  EsveoNotionBlockType,
  EsveoNotionIcon,
  EsveoNotionOption,
  EsveoNotionPageRef,
  EsveoNotionProperty,
  EsveoNotionPropertyValue,
  EsveoNotionScalarValue,
  EsveoNotionSpan,
  EsveoNotionUser,
} from "@t3tools/contracts";

export type Json = Readonly<Record<string, unknown>>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const obj = (value: unknown): Json => (isJson(value) ? value : {});
const arr = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Notion's root for its built-in icons, which it returns as relative paths. */
const NOTION_ORIGIN = "https://www.notion.so";

const absoluteUrl = (url: string) => (url.startsWith("/") ? `${NOTION_ORIGIN}${url}` : url);

/** The URL of an uploaded (`file`) or linked (`external`) Notion file object. */
export function fileObjectUrl(value: unknown): { url: string; hosted: boolean } | null {
  const file = obj(value);
  const type = str(file.type);
  if (type === "file" || type === "file_upload") {
    const url = str(obj(file[type]).url);
    return url === null ? null : { url, hosted: true };
  }
  if (type === "external") {
    const url = str(obj(file.external).url);
    return url === null ? null : { url: absoluteUrl(url), hosted: false };
  }
  return null;
}

export function toIcon(value: unknown): EsveoNotionIcon | null {
  const icon = obj(value);
  if (icon.type === "emoji") {
    const emoji = str(icon.emoji);
    return emoji === null ? null : { kind: "emoji", emoji };
  }
  const file = fileObjectUrl(icon);
  return file === null ? null : { kind: "url", url: file.url };
}

export function toSpans(value: unknown): EsveoNotionSpan[] {
  return arr(value).flatMap((raw): EsveoNotionSpan[] => {
    const item = obj(raw);
    const text = str(item.plain_text) ?? "";
    if (text.length === 0) return [];
    const annotations = obj(item.annotations);
    const span: {
      -readonly [K in keyof EsveoNotionSpan]: EsveoNotionSpan[K];
    } = { text };
    const href = str(item.href);
    if (href !== null) span.href = href;
    if (annotations.bold === true) span.bold = true;
    if (annotations.italic === true) span.italic = true;
    if (annotations.strikethrough === true) span.strikethrough = true;
    if (annotations.underline === true) span.underline = true;
    if (annotations.code === true || item.type === "equation") span.code = true;
    const color = str(annotations.color);
    if (color !== null && color !== "default") span.color = color;
    if (item.type === "mention") {
      const mention = obj(item.mention);
      const type = str(mention.type);
      if (type === "page" || type === "database") {
        span.mention = type;
        const id = str(obj(mention[type]).id);
        if (id !== null) span.pageId = id;
      } else if (type === "user" || type === "date") {
        span.mention = type;
      } else if (type === "link_preview" || type === "link_mention") {
        span.mention = "link";
      }
    }
    return [span];
  });
}

const plainText = (spans: ReadonlyArray<EsveoNotionSpan>) =>
  spans.map((span) => span.text).join("");

export function toUser(value: unknown): EsveoNotionUser | null {
  const user = obj(value);
  const id = str(user.id);
  if (id === null) return null;
  return { id, name: str(user.name), avatarUrl: str(user.avatar_url) };
}

const toOption = (value: unknown): EsveoNotionOption | null => {
  const option = obj(value);
  const name = str(option.name);
  return name === null ? null : { name, color: str(option.color) ?? "default" };
};

const toDate = (value: unknown) => {
  const date = obj(value);
  const start = str(date.start);
  return start === null ? null : { start, end: str(date.end) };
};

const textValue = (text: string | null): EsveoNotionScalarValue => ({ kind: "text", text });

const UNSUPPORTED: EsveoNotionScalarValue = { kind: "unsupported" };

/** A property value of any non-rollup type; rollup arrays hold these. */
function toScalar(type: string, raw: Json): EsveoNotionScalarValue {
  const value = raw[type];
  switch (type) {
    case "title":
    case "rich_text":
      return { kind: "rich_text", spans: toSpans(value) };
    case "number":
      return { kind: "number", number: num(value) };
    case "select":
    case "status":
      return { kind: type, option: toOption(value) };
    case "multi_select":
      return {
        kind: "multi_select",
        options: arr(value).flatMap((option) => toOption(option) ?? []),
      };
    case "date":
      return { kind: "date", date: toDate(value) };
    case "created_time":
    case "last_edited_time": {
      const at = str(value);
      return { kind: "date", date: at === null ? null : { start: at, end: null } };
    }
    case "people":
      return { kind: "people", people: arr(value).flatMap((user) => toUser(user) ?? []) };
    case "created_by":
    case "last_edited_by": {
      const user = toUser(value);
      return { kind: "people", people: user === null ? [] : [user] };
    }
    case "checkbox":
      return { kind: "checkbox", checked: value === true };
    case "url":
    case "email":
      return { kind: type, value: str(value) };
    case "phone_number":
      return { kind: "phone", value: str(value) };
    case "relation":
      return {
        kind: "relation",
        pageIds: arr(value).flatMap((entry) => str(obj(entry).id) ?? []),
        hasMore: raw.has_more === true,
      };
    case "files":
      return {
        kind: "files",
        files: arr(value).map((entry) => {
          const file = obj(entry);
          const source = fileObjectUrl(file);
          const name = str(file.name) ?? source?.url ?? "Datei";
          return source !== null && !source.hosted ? { name, url: source.url } : { name };
        }),
      };
    case "formula": {
      const formula = obj(value);
      const resultType = str(formula.type);
      if (resultType === "string") return textValue(str(formula.string));
      if (resultType === "number") return { kind: "number", number: num(formula.number) };
      if (resultType === "boolean") return { kind: "checkbox", checked: formula.boolean === true };
      if (resultType === "date") return { kind: "date", date: toDate(formula.date) };
      return UNSUPPORTED;
    }
    case "unique_id": {
      const id = obj(value);
      const number = num(id.number);
      const prefix = str(id.prefix);
      return textValue(number === null ? null : prefix ? `${prefix}-${number}` : String(number));
    }
    case "verification": {
      const state = str(obj(value).state);
      return textValue(
        state === "verified" ? "Verifiziert" : state === "expired" ? "Abgelaufen" : null,
      );
    }
    default:
      return UNSUPPORTED;
  }
}

function toPropertyValue(type: string, raw: Json): EsveoNotionPropertyValue {
  if (type !== "rollup") return toScalar(type, raw);
  const rollup = obj(raw.rollup);
  const rollupType = str(rollup.type);
  if (rollupType === "number") return { kind: "rollup", items: [toScalar("number", rollup)] };
  if (rollupType === "date") return { kind: "rollup", items: [toScalar("date", rollup)] };
  if (rollupType === "array") {
    return {
      kind: "rollup",
      items: arr(rollup.array).map((entry) => {
        const item = obj(entry);
        return toScalar(str(item.type) ?? "", item);
      }),
    };
  }
  return { kind: "rollup", items: [] };
}

function isEmptyValue(value: EsveoNotionPropertyValue): boolean {
  switch (value.kind) {
    case "rich_text":
      return value.spans.length === 0;
    case "text":
      return value.text === null || value.text.length === 0;
    case "number":
      return value.number === null;
    case "select":
    case "status":
      return value.option === null;
    case "multi_select":
      return value.options.length === 0;
    case "date":
      return value.date === null;
    case "people":
      return value.people.length === 0;
    case "checkbox":
      return false;
    case "url":
    case "email":
    case "phone":
      return value.value === null || value.value.length === 0;
    case "relation":
      return value.pageIds.length === 0;
    case "files":
      return value.files.length === 0;
    case "rollup":
      return value.items.every(isEmptyValue);
    case "unsupported":
      return false;
  }
}

/** Buttons do nothing in a read-only view. */
const HIDDEN_PROPERTY_TYPES = new Set(["title", "button"]);

/** Filled properties first, then the empty ones, each in the API's order. */
export function toProperties(value: unknown): EsveoNotionProperty[] {
  const properties = Object.entries(obj(value)).flatMap(([name, entry]): EsveoNotionProperty[] => {
    const raw = obj(entry);
    const type = str(raw.type) ?? "unknown";
    if (HIDDEN_PROPERTY_TYPES.has(type)) return [];
    const propertyValue = toPropertyValue(type, raw);
    return [
      {
        id: str(raw.id) ?? name,
        name,
        type,
        empty: isEmptyValue(propertyValue),
        value: propertyValue,
      },
    ];
  });
  return [
    ...properties.filter((property) => !property.empty),
    ...properties.filter((property) => property.empty),
  ];
}

/** A page's title from its `title` property, a database's from its `title` field. */
export function titleOf(raw: Json): string {
  if (raw.object === "database") return plainText(toSpans(raw.title));
  const titleProperty = Object.values(obj(raw.properties)).find(
    (entry) => obj(entry).type === "title",
  );
  return plainText(toSpans(obj(titleProperty).title));
}

export type NotionParent =
  | { readonly kind: "page" | "database" | "block"; readonly id: string }
  | { readonly kind: "workspace" };

export function parentOf(raw: Json): NotionParent {
  const parent = obj(raw.parent);
  switch (parent.type) {
    case "page_id":
      return { kind: "page", id: str(parent.page_id) ?? "" };
    case "database_id":
      return { kind: "database", id: str(parent.database_id) ?? "" };
    case "data_source_id":
      return { kind: "database", id: str(parent.database_id ?? parent.data_source_id) ?? "" };
    case "block_id":
      return { kind: "block", id: str(parent.block_id) ?? "" };
    default:
      return { kind: "workspace" };
  }
}

export function toPageRef(raw: Json): EsveoNotionPageRef {
  const kind = raw.object === "database" ? "database" : "page";
  return {
    id: str(raw.id) ?? "",
    kind,
    title: titleOf(raw) || "Unbenannt",
    icon: toIcon(raw.icon),
    accessible: true,
  };
}

const RICH_TEXT_BLOCKS = new Set<string>([
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
]);
const FILE_BLOCKS = new Set(["file", "pdf", "video", "audio"]);
const LINK_BLOCKS = new Set(["bookmark", "embed", "link_preview"]);
/** Their children belong to another page, so the tree does not descend into them. */
export const LEAF_BLOCKS = new Set(["child_page", "child_database", "link_to_page"]);

type MutableBlock = { -readonly [K in keyof EsveoNotionBlock]: EsveoNotionBlock[K] };

const fileNameFromUrl = (url: string) => {
  try {
    const name = new URL(url).pathname.split("/").findLast((part) => part.length > 0);
    return name === undefined ? url : decodeURIComponent(name);
  } catch {
    return url;
  }
};

/** One block, without children; `children` are converted blocks the tree fetched. */
export function toBlock(
  rawValue: unknown,
  children?: ReadonlyArray<EsveoNotionBlock>,
): EsveoNotionBlock {
  const raw = obj(rawValue);
  const id = str(raw.id) ?? "";
  const notionType = str(raw.type) ?? "unknown";
  const data = obj(raw[notionType]);
  const block: MutableBlock = { id, type: "unsupported" };
  const as = (type: EsveoNotionBlockType) => {
    block.type = type;
  };

  if (RICH_TEXT_BLOCKS.has(notionType)) {
    as(notionType as EsveoNotionBlockType);
    block.spans = toSpans(data.rich_text);
    const color = str(data.color);
    if (color !== null && color !== "default") block.color = color;
    if (notionType === "to_do") block.checked = data.checked === true;
    if (notionType.startsWith("heading_") && data.is_toggleable === true) block.toggleable = true;
    if (notionType === "callout") {
      const icon = toIcon(data.icon);
      if (icon !== null) block.icon = icon;
    }
    if (notionType === "code") {
      block.language = str(data.language) ?? "plain text";
      const caption = toSpans(data.caption);
      if (caption.length > 0) block.caption = caption;
    }
  } else if (notionType === "divider") {
    as("divider");
  } else if (notionType === "equation") {
    as("equation");
    block.expression = str(data.expression) ?? "";
  } else if (notionType === "image" || FILE_BLOCKS.has(notionType)) {
    as(notionType === "image" ? "image" : "file");
    block.notionType = notionType;
    const source = fileObjectUrl(data);
    if (source !== null) {
      block.url = source.url;
      if (source.hosted) block.hosted = true;
    }
    block.name = str(data.name) ?? (source === null ? notionType : fileNameFromUrl(source.url));
    const caption = toSpans(data.caption);
    if (caption.length > 0) block.caption = caption;
  } else if (LINK_BLOCKS.has(notionType)) {
    as("bookmark");
    block.notionType = notionType;
    const url = str(data.url);
    if (url !== null) block.url = url;
    const caption = toSpans(data.caption);
    if (caption.length > 0) block.caption = caption;
  } else if (notionType === "child_page") {
    as("page");
    block.pageId = id;
    block.title = str(data.title) || "Unbenannt";
  } else if (notionType === "child_database") {
    as("database");
    block.pageId = id;
    block.title = str(data.title) || "Datenbank";
  } else if (notionType === "link_to_page") {
    const target = str(data.type);
    const targetId = target === null ? null : str(data[target]);
    if (targetId !== null) {
      as(target === "database_id" ? "database" : "page");
      block.pageId = targetId;
    }
  } else if (notionType === "table") {
    as("table");
    if (data.has_column_header === true) block.columnHeader = true;
    if (data.has_row_header === true) block.rowHeader = true;
  } else if (notionType === "table_row") {
    as("table_row");
    block.cells = arr(data.cells).map(toSpans);
  } else if (
    notionType === "column_list" ||
    notionType === "column" ||
    notionType === "synced_block"
  ) {
    as(notionType);
  }

  if (block.type === "unsupported") block.notionType = notionType;
  if (children !== undefined && children.length > 0) block.children = children;
  return block;
}
