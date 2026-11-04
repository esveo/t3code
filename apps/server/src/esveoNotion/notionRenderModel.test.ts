import { assert, describe, it } from "@effect/vitest";

import fixtures from "./fixtures/notionResponses.json" with { type: "json" };
import { toBlock, toIcon, toProperties, titleOf } from "./notionRenderModel.ts";

describe("toProperties", () => {
  const properties = toProperties(fixtures.page.properties);
  const byName = (name: string) => properties.find((property) => property.name === name);

  it("leaves out the title and buttons and lists filled properties first, in API order", () => {
    assert.isUndefined(byName("Task name"));
    assert.isUndefined(byName("Log Time"));
    const firstEmpty = properties.findIndex((property) => property.empty);
    assert.isTrue(properties.slice(firstEmpty).every((property) => property.empty));
    assert.deepStrictEqual(
      properties.filter((property) => !property.empty).map((property) => property.name),
      [
        "Time Log",
        "Last edited time",
        "Created time",
        "Created by",
        "Summe Stunden",
        "Last edited by",
        "Summary",
        "Assignee",
        "Status",
        "Priority",
        "Topic",
      ],
    );
  });

  it("keeps Notion's option colors, rollup numbers and relation targets", () => {
    assert.deepStrictEqual(byName("Priority")?.value, {
      kind: "select",
      option: { name: "1 next up", color: "red" },
    });
    assert.deepStrictEqual(byName("Status")?.value, {
      kind: "status",
      option: { name: "Not started", color: "default" },
    });
    assert.deepStrictEqual(byName("Summe Stunden")?.value, {
      kind: "rollup",
      items: [{ kind: "number", number: 0.5 }],
    });
    assert.deepStrictEqual(byName("Topic")?.value, {
      kind: "relation",
      pageIds: [fixtures.page.properties.Topic.relation[0]!.id],
      hasMore: false,
    });
    assert.strictEqual(byName("Due")?.empty, true);
  });

  it("falls back to unsupported for property types it does not know", () => {
    const [property] = toProperties({ Odd: { id: "x", type: "hologram", hologram: {} } });
    assert.deepStrictEqual(property?.value, { kind: "unsupported" });
    assert.strictEqual(property?.empty, false);
  });
});

describe("toBlock", () => {
  it("converts the page's blocks and nests a toggle's prefetched children", () => {
    const [callout, heading, toggle] = fixtures.children.results;
    assert.strictEqual(toBlock(callout).type, "callout");
    assert.strictEqual(toBlock(heading).type, "heading_2");
    const children = fixtures.toggle1.results.map((raw) => toBlock(raw));
    const block = toBlock(toggle, children);
    assert.strictEqual(block.type, "toggle");
    const file = block.children?.[0];
    assert.strictEqual(file?.type, "file");
    assert.strictEqual(file?.notionType, "file");
    assert.strictEqual(file?.hosted, true);
    assert.strictEqual(file?.name, "Datei.xlsx");
  });

  it("keeps an empty paragraph as a spacer", () => {
    const empty = fixtures.children.results.find(
      (raw) => raw.type === "paragraph" && raw.paragraph?.rich_text.length === 0,
    );
    assert.deepStrictEqual(toBlock(empty), {
      id: empty?.id ?? "",
      type: "paragraph",
      spans: [],
    });
  });

  it("marks unknown blocks unsupported with Notion's type", () => {
    assert.deepStrictEqual(toBlock({ id: "b", type: "ai_block", ai_block: {} }), {
      id: "b",
      type: "unsupported",
      notionType: "ai_block",
    });
  });

  it("maps links to pages and databases, child pages and mentions", () => {
    assert.deepStrictEqual(
      toBlock({ id: "l", type: "link_to_page", link_to_page: { type: "page_id", page_id: "p1" } }),
      { id: "l", type: "page", pageId: "p1" },
    );
    assert.deepStrictEqual(
      toBlock({ id: "c", type: "child_database", child_database: { title: "Tasks" } }),
      { id: "c", type: "database", pageId: "c", title: "Tasks" },
    );
    const paragraph = toBlock({
      id: "m",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "mention",
            plain_text: "Seite",
            href: "https://www.notion.so/p2",
            mention: { type: "page", page: { id: "p2" } },
            annotations: { bold: true, color: "red" },
          },
        ],
      },
    });
    assert.deepStrictEqual(paragraph.spans, [
      {
        text: "Seite",
        href: "https://www.notion.so/p2",
        bold: true,
        color: "red",
        mention: "page",
        pageId: "p2",
      },
    ]);
  });
});

describe("page header", () => {
  it("reads titles of pages and databases and makes Notion's relative icons absolute", () => {
    assert.strictEqual(titleOf(fixtures.page), "Text 1");
    assert.strictEqual(titleOf(fixtures.db), "Text 11");
    assert.deepStrictEqual(toIcon({ type: "external", external: { url: "/images/x.svg" } }), {
      kind: "url",
      url: "https://www.notion.so/images/x.svg",
    });
    assert.isNull(toIcon({ type: "icon", icon: { name: "star", color: "gray" } }));
  });
});
