import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId, type ContextMenuItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parentThreadCandidates, withThreadParentMenuItems } from "./threadParent.logic";

const ENV = EnvironmentId.make("env-1");
const thread = (
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell =>
  ({
    id: ThreadId.make(id),
    environmentId: ENV,
    archivedAt: null,
    updatedAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  }) as EnvironmentThreadShell;

describe("parentThreadCandidates", () => {
  it("offers open top-level threads of the environment, coordinators first", () => {
    const analysis = thread("analysis");
    const coordinator = thread("coordinator", { updatedAt: "2026-09-23T08:00:00.000Z" });
    const recent = thread("recent", { updatedAt: "2026-09-23T12:00:00.000Z" });
    const child = thread("child", { parentThreadId: coordinator.id });
    const archived = thread("archived", { archivedAt: "2026-09-22T10:00:00.000Z" });
    const elsewhere = thread("elsewhere", { environmentId: EnvironmentId.make("env-2") });
    const candidates = parentThreadCandidates(
      [analysis, coordinator, recent, child, archived, elsewhere],
      analysis,
    );
    expect(candidates.map((candidate) => candidate.id)).toEqual(["coordinator", "recent"]);
    // A child can move, but not to the coordinator it already has.
    expect(parentThreadCandidates([analysis, coordinator, recent, child], child)).toEqual([
      recent,
      analysis,
    ]);
  });

  it("offers nothing to a thread that coordinates threads of its own", () => {
    const coordinator = thread("coordinator");
    const child = thread("child", { parentThreadId: coordinator.id });
    expect(parentThreadCandidates([coordinator, child, thread("other")], coordinator)).toEqual([]);
  });
});

describe("withThreadParentMenuItems", () => {
  const items: ReadonlyArray<ContextMenuItem> = [
    { id: "rename", label: "Rename" },
    { id: "copy", label: "Copy" },
  ];
  const ids = (state: Parameters<typeof withThreadParentMenuItems>[1]) =>
    withThreadParentMenuItems(items, state).map((item) => item.id);

  it("adds assign before Copy while orchestration is on", () => {
    expect(ids({ orchestrationEnabled: true, hasParent: false, hasChildren: false })).toEqual([
      "rename",
      "assign-parent",
      "copy",
    ]);
    expect(ids({ orchestrationEnabled: false, hasParent: false, hasChildren: false })).toEqual([
      "rename",
      "copy",
    ]);
    expect(ids({ orchestrationEnabled: true, hasParent: false, hasChildren: true })).toEqual([
      "rename",
      "copy",
    ]);
  });

  it("always lets a child be detached", () => {
    expect(ids({ orchestrationEnabled: false, hasParent: true, hasChildren: false })).toEqual([
      "rename",
      "detach-parent",
      "copy",
    ]);
  });
});
