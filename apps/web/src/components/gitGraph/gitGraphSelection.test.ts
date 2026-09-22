import type { VcsCommitGraphEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { gitGraphDiffRange, nextGitGraphSelection, WORKTREE_ID } from "./gitGraphSelection";

const commit = (sha: string, parents: ReadonlyArray<string>): VcsCommitGraphEntry => ({
  sha,
  parents,
  refs: [],
  author: "",
  authoredAt: "2026-01-01T00:00:00Z",
  subject: sha,
});

// Newest first, as the graph draws them.
const commits = [
  commit(WORKTREE_ID, ["ccc"]),
  commit("ccc", ["bbb"]),
  commit("bbb", ["aaa"]),
  commit("aaa", []),
];

describe("nextGitGraphSelection", () => {
  it("selects one point per plain click and clears on a second click", () => {
    expect(nextGitGraphSelection(["aaa", "bbb"], "ccc", false)).toEqual(["ccc"]);
    expect(nextGitGraphSelection(["ccc"], "ccc", false)).toEqual([]);
  });

  it("adds, removes and replaces the compared point on a modifier click", () => {
    expect(nextGitGraphSelection(["aaa"], "ccc", true)).toEqual(["aaa", "ccc"]);
    expect(nextGitGraphSelection(["aaa", "ccc"], "aaa", true)).toEqual(["ccc"]);
    expect(nextGitGraphSelection(["aaa", "ccc"], "bbb", true)).toEqual(["aaa", "bbb"]);
  });
});

describe("gitGraphDiffRange", () => {
  it("diffs a single commit against its first parent, or the empty tree at the root", () => {
    expect(gitGraphDiffRange(["bbb"], commits)).toEqual({ base: "aaa", head: "bbb" });
    expect(gitGraphDiffRange(["aaa"], commits)).toEqual({ base: null, head: "aaa" });
  });

  it("diffs the worktree against HEAD", () => {
    expect(gitGraphDiffRange([WORKTREE_ID], commits)).toEqual({ base: "ccc", head: null });
  });

  it("orders two points older to newer whatever the click order", () => {
    expect(gitGraphDiffRange(["ccc", "aaa"], commits)).toEqual({ base: "aaa", head: "ccc" });
    expect(gitGraphDiffRange(["aaa", WORKTREE_ID], commits)).toEqual({ base: "aaa", head: null });
  });

  it("gives up on a point that left the graph", () => {
    expect(gitGraphDiffRange(["ddd"], commits)).toBeNull();
    expect(gitGraphDiffRange([], commits)).toBeNull();
  });
});
