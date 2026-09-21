import { describe, expect, it } from "vite-plus/test";

import { nextGitGraphPanelStep } from "./gitGraphPanelLadder";

describe("nextGitGraphPanelStep", () => {
  it("opens the graph when it is not on show", () => {
    expect(nextGitGraphPanelStep({ showing: false, canMaximize: true, maximized: false })).toBe(
      "open",
    );
    // A maximized panel showing something else still only needs opening.
    expect(nextGitGraphPanelStep({ showing: false, canMaximize: true, maximized: true })).toBe(
      "open",
    );
  });

  it("gives the graph the window before putting it away", () => {
    expect(nextGitGraphPanelStep({ showing: true, canMaximize: true, maximized: false })).toBe(
      "maximize",
    );
    expect(nextGitGraphPanelStep({ showing: true, canMaximize: true, maximized: true })).toBe(
      "close",
    );
  });

  it("closes straight from the panel where maximizing is unavailable", () => {
    expect(nextGitGraphPanelStep({ showing: true, canMaximize: false, maximized: false })).toBe(
      "close",
    );
  });
});
