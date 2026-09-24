import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { gitGraphRefreshDelay, gitGraphStatusKey } from "./gitGraphRefresh.logic";

const status = (overrides: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "fork",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  ...overrides,
});

const dirty = (paths: ReadonlyArray<string>, insertions: number) =>
  status({
    hasWorkingTreeChanges: true,
    workingTree: {
      files: paths.map((path) => ({ path, insertions, deletions: 0 })),
      insertions: insertions * paths.length,
      deletions: 0,
    },
  });

describe("gitGraphStatusKey", () => {
  it("changes when the branch, the upstream counters or the changed files move", () => {
    const base = gitGraphStatusKey(status());
    expect(gitGraphStatusKey(status())).toBe(base);
    expect(gitGraphStatusKey(status({ refName: "main" }))).not.toBe(base);
    expect(gitGraphStatusKey(status({ aheadCount: 1 }))).not.toBe(base);
    expect(gitGraphStatusKey(status({ behindCount: 2 }))).not.toBe(base);
    expect(gitGraphStatusKey(dirty(["a.ts"], 3))).not.toBe(base);
    // Committing one of two changed files moves the graph.
    expect(gitGraphStatusKey(dirty(["a.ts"], 3))).not.toBe(
      gitGraphStatusKey(dirty(["a.ts", "b.ts"], 3)),
    );
  });

  it("ignores what does not move commits, and is null without a status", () => {
    const base = gitGraphStatusKey(status());
    expect(gitGraphStatusKey(status({ hasPrimaryRemote: false }))).toBe(base);
    // An agent writing to the same file again does not read git log again.
    expect(gitGraphStatusKey(dirty(["a.ts"], 3))).toBe(gitGraphStatusKey(dirty(["a.ts"], 9)));
    expect(gitGraphStatusKey(null)).toBeNull();
    expect(gitGraphStatusKey(undefined)).toBeNull();
  });
});

describe("gitGraphRefreshDelay", () => {
  it("waits for nothing when the last read already saw this status", () => {
    expect(
      gitGraphRefreshDelay({ statusKey: "a", readKey: "a", dataUpdatedAt: 0, now: 60_000 }),
    ).toBeNull();
    expect(
      gitGraphRefreshDelay({ statusKey: null, readKey: "a", dataUpdatedAt: 0, now: 60_000 }),
    ).toBeNull();
  });

  it("reads at once when the last read is stale or missing", () => {
    expect(
      gitGraphRefreshDelay({ statusKey: "b", readKey: "a", dataUpdatedAt: 10_000, now: 16_000 }),
    ).toBe(0);
    expect(
      gitGraphRefreshDelay({ statusKey: "b", readKey: null, dataUpdatedAt: null, now: 16_000 }),
    ).toBe(0);
  });

  it("defers a change inside the fresh window instead of dropping it", () => {
    expect(
      gitGraphRefreshDelay({ statusKey: "b", readKey: "a", dataUpdatedAt: 10_000, now: 12_000 }),
    ).toBe(3_000);
  });
});
