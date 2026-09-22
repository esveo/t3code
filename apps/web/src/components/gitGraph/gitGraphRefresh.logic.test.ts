import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { gitGraphIsFresh, gitGraphStatusKey } from "./gitGraphRefresh.logic";

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

describe("gitGraphStatusKey", () => {
  it("changes when the branch, the upstream counters or the working tree move", () => {
    const base = gitGraphStatusKey(status());
    expect(gitGraphStatusKey(status())).toBe(base);
    expect(gitGraphStatusKey(status({ refName: "main" }))).not.toBe(base);
    expect(gitGraphStatusKey(status({ aheadCount: 1 }))).not.toBe(base);
    expect(gitGraphStatusKey(status({ behindCount: 2 }))).not.toBe(base);
    expect(
      gitGraphStatusKey(
        status({
          hasWorkingTreeChanges: true,
          workingTree: { files: [], insertions: 3, deletions: 0 },
        }),
      ),
    ).not.toBe(base);
  });

  it("ignores what does not move commits, and is null without a status", () => {
    const base = gitGraphStatusKey(status());
    expect(gitGraphStatusKey(status({ hasPrimaryRemote: false }))).toBe(base);
    expect(gitGraphStatusKey(null)).toBeNull();
    expect(gitGraphStatusKey(undefined)).toBeNull();
  });
});

describe("gitGraphIsFresh", () => {
  it("treats a read from the last seconds as fresh and anything else as stale", () => {
    expect(gitGraphIsFresh(10_000, 12_000)).toBe(true);
    expect(gitGraphIsFresh(10_000, 16_000)).toBe(false);
    expect(gitGraphIsFresh(null, 16_000)).toBe(false);
  });
});
