import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupChildThreads, visibleChildThreads } from "./childThreads.logic";
import { buildThreadOverview, waitingThreadCount } from "./threadOverview.logic";

const ENV = EnvironmentId.make("env-1");
const thread = (
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell =>
  ({
    id: ThreadId.make(id),
    environmentId: ENV,
    archivedAt: null,
    createdAt: `2026-09-23T10:00:0${id.length % 10}.000Z`,
    updatedAt: "2026-09-23T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    pullRequests: [],
    planProgress: null,
    ...overrides,
  }) as EnvironmentThreadShell;
const key = (id: string) => scopedThreadKey(scopeThreadRef(ENV, ThreadId.make(id)));
const session = (status: string) => ({ status }) as EnvironmentThreadShell["session"];

describe("groupChildThreads", () => {
  it("nests children under a listed coordinator and frees orphans", () => {
    const coordinator = thread("coord");
    const child = thread("c1", { parentThreadId: coordinator.id });
    const orphan = thread("c2", { parentThreadId: ThreadId.make("gone") });
    const archivedParent = thread("old", { archivedAt: "2026-09-22T00:00:00.000Z" });
    const childOfArchived = thread("c3", { parentThreadId: archivedParent.id });

    const groups = groupChildThreads([coordinator, child, orphan, archivedParent, childOfArchived]);
    expect(groups.childrenByParentKey.get(key("coord"))?.map((t) => t.id)).toEqual(["c1"]);
    expect([...groups.nestedThreadKeys]).toEqual([key("c1")]);
  });

  it("keeps a folded group's children that need the user or are open", () => {
    const children = [
      thread("working", { session: session("running") }),
      thread("waiting", { hasPendingUserInput: true }),
      thread("open"),
    ];
    expect(
      visibleChildThreads({ children, collapsed: true, openThreadKey: key("open") }).map(
        (t) => t.id,
      ),
    ).toEqual(["waiting", "open"]);
    expect(visibleChildThreads({ children, collapsed: false, openThreadKey: null })).toHaveLength(
      3,
    );
  });
});

describe("buildThreadOverview", () => {
  it("orders sections by what the user acts on first and leaves empty ones out", () => {
    const children = [
      thread("done"),
      thread("failed", { session: session("error") }),
      thread("working", { session: session("running") }),
      thread("asks", { hasPendingApprovals: true }),
    ];
    const groups = buildThreadOverview(children);
    expect(groups.map((group) => [group.id, group.threads.map((t) => t.id)])).toEqual([
      ["waiting", expect.arrayContaining(["failed", "asks"])],
      ["working", ["working"]],
      ["done", ["done"]],
    ]);
    expect(waitingThreadCount(children)).toBe(2);
  });
});
