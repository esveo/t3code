import { describe, expect, it } from "vite-plus/test";

import { resizedGitGraphColumnWidth } from "./gitGraphColumns";

describe("resizedGitGraphColumnWidth", () => {
  it("widens the graph when its right edge moves right", () => {
    expect(resizedGitGraphColumnWidth("graph", 100, 30)).toBe(130);
  });

  it("widens the right-hand columns when their left edge moves left", () => {
    expect(resizedGitGraphColumnWidth("author", 144, -20)).toBe(164);
    expect(resizedGitGraphColumnWidth("sha", 64, 10)).toBe(54);
  });

  it("keeps every column within its bounds", () => {
    expect(resizedGitGraphColumnWidth("date", 48, 500)).toBe(32);
    expect(resizedGitGraphColumnWidth("graph", 100, 5000)).toBe(640);
  });
});
