import { describe, expect, it } from "@effect/vitest";

import { normalizeNotionId, parseNotionPageUrl } from "./esveoNotion.ts";

const ID = "3fff33b2-9e8e-81da-b09c-e06877f6abeb";
const HEX = ID.replaceAll("-", "");

describe("parseNotionPageUrl", () => {
  it.each([
    `https://www.notion.so/esveo/Fixkosten-Aufstellung-${HEX}`,
    `https://notion.so/${HEX}`,
    `https://www.notion.so/esveo/${HEX}?pvs=4#heading`,
    `https://app.notion.com/p/Fixkosten-Aufstellung-${HEX}`,
    `https://esveo.notion.site/Seite-${HEX}`,
    `https://www.notion.so/esveo/${"0".repeat(32)}?v=1&p=${HEX}&pm=s`,
    `https://www.notion.so/${ID}`,
  ])("reads the page id from %s", (href) => {
    expect(parseNotionPageUrl(href)).toBe(ID);
  });

  it.each([
    "https://www.notion.so/profile/integrations",
    `https://example.com/${HEX}`,
    `https://notion.so.evil.com/${HEX}`,
    `notion://www.notion.so/${HEX}`,
    "not a url",
  ])("ignores %s", (href) => {
    expect(parseNotionPageUrl(href)).toBeNull();
  });
});

it("normalizes bare ids with or without dashes", () => {
  expect(normalizeNotionId(HEX.toUpperCase())).toBe(ID);
  expect(normalizeNotionId(` ${ID} `)).toBe(ID);
  expect(normalizeNotionId("abc")).toBeNull();
});
