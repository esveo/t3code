import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PullRequestListLine } from "../pullRequest/pullRequestListLines";
import { groupPullRequestLinesByStatus } from "./pullRequestStatusGroups.logic";

function line(
  number: number,
  state: "open" | "closed" | "merged" | null,
  options: { isDraft?: boolean; depth?: number; chainKey?: string; stackSize?: number } = {},
): PullRequestListLine {
  const link = {
    host: "github.com",
    repository: "esveo/t3code",
    number,
    snapshot:
      state === null ? null : { state, isDraft: options.isDraft ?? false, title: `PR ${number}` },
  } as unknown as ThreadPullRequestLink;
  return {
    link,
    depth: options.depth ?? 0,
    chainKey: options.chainKey ?? `#${number}`,
    stack: options.stackSize ? { kind: "native", size: options.stackSize } : null,
  };
}

const summarize = (lines: ReadonlyArray<PullRequestListLine>) =>
  groupPullRequestLinesByStatus(lines).map((group) => ({
    id: group.id,
    lines: group.lines.map((entry) => [entry.link.number, entry.depth, entry.stack?.size ?? 0]),
  }));

describe("groupPullRequestLinesByStatus", () => {
  it("sorts lines into open, draft, merged and closed, keeping their order", () => {
    expect(
      summarize([
        line(5, "merged"),
        line(4, "open", { isDraft: true }),
        line(3, null),
        line(2, "closed"),
        line(1, "open"),
      ]),
    ).toEqual([
      {
        id: "open",
        lines: [
          [3, 0, 0],
          [1, 0, 0],
        ],
      },
      { id: "draft", lines: [[4, 0, 0]] },
      { id: "merged", lines: [[5, 0, 0]] },
      { id: "closed", lines: [[2, 0, 0]] },
    ]);
  });

  it("re-indents a stack split across sections and keeps its badge on each part", () => {
    expect(
      summarize([
        line(1, "merged", { chainKey: "s", depth: 0, stackSize: 3 }),
        line(2, "open", { chainKey: "s", depth: 1 }),
        line(3, "open", { chainKey: "s", depth: 2 }),
      ]),
    ).toEqual([
      {
        id: "open",
        lines: [
          [2, 0, 3],
          [3, 1, 0],
        ],
      },
      { id: "merged", lines: [[1, 0, 3]] },
    ]);
  });
});
