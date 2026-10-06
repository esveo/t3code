import { describe, expect, it } from "vite-plus/test";

import { isPullRequestDiffOutdated, pullRequestDiffRevision } from "./pullRequestDiffUpdate.logic";

const detail = {
  baseBranch: "main",
  headSha: "abc",
  additions: 3,
  deletions: 1,
  changedFiles: 2,
};

describe("pullRequestDiffRevision", () => {
  it("follows the head commit and the base", () => {
    expect(pullRequestDiffRevision(detail)).not.toBe(
      pullRequestDiffRevision({ ...detail, headSha: "def" }),
    );
    expect(pullRequestDiffRevision(detail)).not.toBe(
      pullRequestDiffRevision({ ...detail, baseBranch: "develop" }),
    );
  });

  it("falls back to the change's size without a head commit", () => {
    const { headSha: _, ...withoutHead } = detail;
    expect(pullRequestDiffRevision(withoutHead)).not.toBe(
      pullRequestDiffRevision({ ...withoutHead, additions: 4 }),
    );
  });
});

describe("isPullRequestDiffOutdated", () => {
  const shown = { key: "pr-1", revision: "main@abc" };

  it("is outdated only for a newer revision of the same pull request", () => {
    expect(isPullRequestDiffOutdated(shown, "pr-1", "main@def")).toBe(true);
    expect(isPullRequestDiffOutdated(shown, "pr-1", "main@abc")).toBe(false);
    expect(isPullRequestDiffOutdated(shown, "pr-2", "main@def")).toBe(false);
    expect(isPullRequestDiffOutdated(null, "pr-1", "main@def")).toBe(false);
    expect(isPullRequestDiffOutdated(shown, "pr-1", null)).toBe(false);
  });
});
