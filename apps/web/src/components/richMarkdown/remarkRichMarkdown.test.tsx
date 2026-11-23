import { describe, expect, it } from "vitest";

import { isFenceClosed } from "./remarkRichMarkdown";

describe("isFenceClosed", () => {
  it.each([
    ["```mermaid\ngraph TD\n```", true],
    ["~~~~mermaid\ngraph TD\n~~~~", true],
    ["```mermaid\ngraph TD", false],
    ["`mermaid\ngraph TD\n`", false],
  ])("recognizes complete fenced diagrams", (source, expected) => {
    expect(isFenceClosed(source)).toBe(expected);
  });
});
