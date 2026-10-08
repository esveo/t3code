import { describe, expect, it } from "vite-plus/test";

import { homeFallbackPath } from "./homePathFallback";

describe("homeFallbackPath", () => {
  it("looks for a workspace-relative path below the home folder", () => {
    expect(homeFallbackPath(".claude/settings.json", "/Users/paul/src/app")).toBe(
      "/Users/paul/.claude/settings.json",
    );
    expect(homeFallbackPath(".config/app.toml", "/home/dev/repo")).toBe(
      "/home/dev/.config/app.toml",
    );
    expect(homeFallbackPath(".claude\\settings.json", "C:\\Users\\dev\\repo")).toBe(
      "C:\\Users\\dev\\.claude\\settings.json",
    );
  });

  it("has nothing to try for host paths, unknown homes, or a workspace at home", () => {
    expect(homeFallbackPath("/etc/hosts", "/Users/paul/src/app")).toBeNull();
    expect(homeFallbackPath("~/notes.md", "/Users/paul/src/app")).toBeNull();
    expect(homeFallbackPath(".claude/settings.json", "/srv/app")).toBeNull();
    expect(homeFallbackPath(".claude/settings.json", "/Users/paul")).toBeNull();
    expect(homeFallbackPath(null, "/Users/paul/src/app")).toBeNull();
  });
});
