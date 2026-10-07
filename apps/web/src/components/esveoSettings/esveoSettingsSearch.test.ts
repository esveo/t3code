import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "../settings/settingsSearch";
import { ESVEO_SETTINGS_QUERY } from "./esveoSettingsSearch";

describe("esveo settings search", () => {
  it("lists exactly the settings esveo's fork adds", () => {
    expect(
      searchSettings(ESVEO_SETTINGS_QUERY)
        .map((item) => item.id)
        .toSorted(),
    ).toEqual(
      [
        "agent-stage",
        "bitbucket-credentials",
        "context-window-control",
        "cross-project-threads",
        "easter-eggs",
        "group-sidebar-threads-by-project",
        "idle-auto-compact",
        "idle-auto-compact-after",
        "idle-auto-compact-threshold",
        "prompt-cache-timer",
        "sidebar-child-threads",
        "thread-decisions",
        "thread-details-open-by-default",
        "two-line-thread-cards",
        "voice-input",
      ].toSorted(),
    );
  });

  it("still finds a fork setting by its own words", () => {
    expect(searchSettings("voice input esveo").map((item) => item.id)).toEqual(["voice-input"]);
  });
});
