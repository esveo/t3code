import { describe, expect, it } from "@effect/vitest";

import { suggestBranches } from "./branchSuggestions.ts";

const refs = [
  { name: "main" },
  { name: "feat/financial-facts-v2" },
  { name: "feat/financial-facts" },
  { name: "origin/HEAD", isRemote: true, remoteName: "origin" },
  { name: "origin/main", isRemote: true, remoteName: "origin" },
  { name: "origin/feat/financial-facts-v2", isRemote: true, remoteName: "origin" },
  { name: "origin/fix/report-export", isRemote: true, remoteName: "origin" },
];

describe("suggestBranches", () => {
  it("prefers branches ending in the name, locals before remotes", () => {
    expect(suggestBranches("financial-facts-v2", refs)).toEqual([
      "feat/financial-facts-v2",
      "origin/feat/financial-facts-v2",
      "feat/financial-facts",
    ]);
  });

  it("offers the remote branch for a name that only exists there", () => {
    expect(suggestBranches("fix/report-export", refs)).toEqual(["origin/fix/report-export"]);
  });

  it("catches typos but not unrelated names", () => {
    expect(suggestBranches("financal-facts-v2", refs).slice(0, 2)).toEqual([
      "feat/financial-facts-v2",
      "origin/feat/financial-facts-v2",
    ]);
    expect(suggestBranches("payments", refs)).toEqual([]);
  });

  it("suggests at most five", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `team${index}/release` }));
    expect(suggestBranches("release", many)).toHaveLength(5);
  });
});
