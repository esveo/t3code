import { ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { inheritedPullRequestLinks } from "./InheritedPullRequestRepair.ts";

const link = (
  number: number,
  linkedAt: string,
  source: ThreadPullRequestLink["source"] = "agent",
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "esveo/t3code",
  number,
  url: `https://github.com/esveo/t3code/pull/${number}`,
  source,
  linkedAt,
  snapshot: null,
  stack: null,
});

const shell = (
  id: string,
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  kind: "subagent" | "fork" | "top-level" = "subagent",
) => ({
  id: ThreadId.make(id),
  lineage: {
    parentThreadId: kind === "top-level" ? null : ThreadId.make("coordinator"),
    relationshipToParent: kind === "top-level" ? null : kind,
    rootThreadId: ThreadId.make("coordinator"),
  },
  createdAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
  pullRequests,
  deletedAt: null,
});

describe("inheritedPullRequestLinks", () => {
  it("picks the links a subagent thread got before it existed", () => {
    const shells = [
      shell("child", [
        link(1, "2026-09-30T09:00:00.000Z"),
        link(2, "2026-10-02T13:00:00.000Z"),
        link(3, "2026-09-30T09:00:00.000Z", "stack-dismissed"),
      ]),
      shell("fork", [link(4, "2026-09-30T09:00:00.000Z")], "fork"),
      shell("coordinator", [link(5, "2026-09-30T09:00:00.000Z")], "top-level"),
    ];
    expect(inheritedPullRequestLinks(shells)).toEqual([
      { threadId: "child", host: "github.com", repository: "esveo/t3code", number: 1 },
    ]);
  });
});
