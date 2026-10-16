import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  scheduledTaskThreadOptions,
  withScheduledTaskProject,
  withScheduledTaskThread,
} from "./scheduledTaskLocation.logic";

const bound = { projectId: "project-a", threadId: "thread-1", spawnAsSubthread: true };

const thread = (
  id: string,
  overrides: Partial<{
    title: string;
    updatedAt: string;
    archivedAt: string | null;
    relationshipToParent: "fork" | "subagent" | null;
  }> = {},
) =>
  ({
    id,
    title: overrides.title ?? id,
    updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    lineage: { relationshipToParent: overrides.relationshipToParent ?? null },
  }) as unknown as EnvironmentThreadShell;

describe("scheduled task location", () => {
  it("going back to a new thread each run clears the subthread setting", () => {
    expect(withScheduledTaskThread(bound, "")).toEqual({
      projectId: "project-a",
      threadId: "",
      spawnAsSubthread: false,
    });
    expect(withScheduledTaskThread(bound, "thread-2").spawnAsSubthread).toBe(true);
  });

  it("changing the project drops a thread of the old one", () => {
    expect(withScheduledTaskProject(bound, "project-b")).toEqual({
      projectId: "project-b",
      threadId: "",
      spawnAsSubthread: false,
    });
    expect(withScheduledTaskProject(bound, "project-a")).toBe(bound);
  });

  it("offers live top-level threads matching the search, newest first", () => {
    const options = scheduledTaskThreadOptions(
      [
        thread("old", { title: "Nightly triage", updatedAt: "2026-09-01T00:00:00.000Z" }),
        thread("new", { title: "Triage bugs", updatedAt: "2026-10-10T00:00:00.000Z" }),
        thread("archived", { title: "Triage archive", archivedAt: "2026-10-02T00:00:00.000Z" }),
        thread("subagent", { title: "Triage helper", relationshipToParent: "subagent" }),
        thread("other", { title: "Release notes" }),
      ],
      " triage ",
    );
    expect(options.map((entry) => entry.id)).toEqual(["new", "old"]);
  });
});
