import { describe, expect, it } from "vite-plus/test";

import {
  collectForkChangelogCommits,
  findNewForkChangelogEntries,
  parseForkChangelog,
} from "./forkChangelog.logic";

const link = (sha: string) => `[${sha.slice(0, 7)}](https://github.com/esveo/t3code/commit/${sha})`;
const A = "aaaaaaa1111111111111111111111111111111111";
const B = "bbbbbbb2222222222222222222222222222222222";
const C = "ccccccc3333333333333333333333333333333333";

const CHANGELOG = `# Changelog

Every feature and fix this fork adds on top of [T3 Code](https://github.com/pingdotgg/t3code).

- Thread orchestration (opt-in): coordinators settle threads with \`settle_thread\` (${link(A)}, Fix: ${link(B)}).
- Split view: threads side by side (${link(C)})
`;

describe("parseForkChangelog", () => {
  it("reads each bullet's sentence and its commits, and skips the preamble", () => {
    expect(parseForkChangelog(CHANGELOG)).toEqual([
      {
        text: "Thread orchestration (opt-in): coordinators settle threads with `settle_thread`",
        commits: ["aaaaaaa", "bbbbbbb"],
      },
      { text: "Split view: threads side by side", commits: ["ccccccc"] },
    ]);
  });
});

describe("findNewForkChangelogEntries", () => {
  const entries = parseForkChangelog(CHANGELOG);

  it("shows nothing on a client's first start", () => {
    expect(findNewForkChangelogEntries(entries, null)).toEqual([]);
  });

  it("shows the entries whose commits the client has not seen", () => {
    const seen = new Set(["ccccccc"]);
    expect(findNewForkChangelogEntries(entries, seen).map((entry) => entry.commits[0])).toEqual([
      "aaaaaaa",
    ]);
  });

  it("shows an entry again once it gains a fix", () => {
    const seen = new Set(["aaaaaaa", "ccccccc"]);
    expect(findNewForkChangelogEntries(entries, seen)).toHaveLength(1);
  });

  it("shows nothing once every commit was seen", () => {
    const seen = new Set(collectForkChangelogCommits(entries));
    expect(findNewForkChangelogEntries(entries, seen)).toEqual([]);
  });
});
