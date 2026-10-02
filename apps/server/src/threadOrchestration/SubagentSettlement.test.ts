import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { subagentsToSettle } from "./SubagentSettlement.ts";

const shell = (
  id: string,
  overrides: {
    readonly parent?: string;
    readonly relationship?: "fork" | "subagent";
    readonly settledOverride?: "settled" | "active" | null;
    readonly archived?: boolean;
  } = {},
) => ({
  id: ThreadId.make(id),
  lineage: {
    parentThreadId: overrides.parent === undefined ? null : ThreadId.make(overrides.parent),
    relationshipToParent:
      overrides.parent === undefined ? null : (overrides.relationship ?? "subagent"),
    rootThreadId: ThreadId.make(id),
  },
  archivedAt: overrides.archived ? ("2026-10-01T00:00:00.000Z" as never) : null,
  deletedAt: null,
  settledOverride: overrides.settledOverride ?? null,
});

describe("subagentsToSettle", () => {
  it("settles open subagents of a settled parent", () => {
    const shells = [
      shell("parent", { settledOverride: "settled" }),
      shell("child", { parent: "parent" }),
      shell("settled-child", { parent: "parent", settledOverride: "settled" }),
      shell("archived-child", { parent: "parent", archived: true }),
    ];
    expect(subagentsToSettle(shells)).toEqual(["child"]);
  });

  it("keeps subagents of an open parent, forks, and children the user reopened", () => {
    const shells = [
      shell("open-parent"),
      shell("open-child", { parent: "open-parent" }),
      shell("parent", { settledOverride: "settled" }),
      shell("fork", { parent: "parent", relationship: "fork" }),
      shell("reopened", { parent: "parent", settledOverride: "active" }),
    ];
    expect(subagentsToSettle(shells)).toEqual([]);
  });

  it("limits the cascade to one parent", () => {
    const shells = [
      shell("a", { settledOverride: "settled" }),
      shell("b", { settledOverride: "settled" }),
      shell("a-child", { parent: "a" }),
      shell("b-child", { parent: "b" }),
    ];
    expect(subagentsToSettle(shells, ThreadId.make("a"))).toEqual(["a-child"]);
  });
});
