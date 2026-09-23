import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crossProjectCoordinatorKeys,
  groupChildThreads,
  visibleChildThreads,
} from "./childThreads.logic";
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

  it("stops treating a thread as coordinator once its last child is detached", () => {
    const coordinator = thread("coord");
    const detached = thread("c1", { parentThreadId: null });

    const groups = groupChildThreads([coordinator, detached]);
    expect(groups.childrenByParentKey.has(key("coord"))).toBe(false);
    expect(groups.nestedThreadKeys.size).toBe(0);
  });

  it("lists a settled child on the settled shelf, not under its open coordinator", () => {
    const coordinator = thread("coord");
    const openChild = thread("c1", { parentThreadId: coordinator.id });
    const settledChild = thread("c2", {
      parentThreadId: coordinator.id,
      settledOverride: "settled",
    });
    const groups = groupChildThreads([coordinator, openChild, settledChild]);
    expect(groups.childrenByParentKey.get(key("coord"))?.map((t) => t.id)).toEqual(["c1"]);
    expect(groups.nestedThreadKeys.has(key("c2"))).toBe(false);

    // Settled together, they nest again on the settled shelf.
    const settledCoordinator = { ...coordinator, settledOverride: "settled" as const };
    const together = groupChildThreads([settledCoordinator, settledChild]);
    expect(together.childrenByParentKey.get(key("coord"))?.map((t) => t.id)).toEqual(["c2"]);
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

describe("crossProjectCoordinatorKeys", () => {
  it("moves a coordinator out of its project once its work spans projects", () => {
    const projectA = "project-a" as EnvironmentThreadShell["projectId"];
    const projectB = "project-b" as EnvironmentThreadShell["projectId"];
    const local = thread("local", { projectId: projectA });
    const localChild = thread("lc", { projectId: projectA, parentThreadId: local.id });
    const spanning = thread("spanning", { projectId: projectA });
    const sameChild = thread("s1", { projectId: projectA, parentThreadId: spanning.id });
    const otherChild = thread("s2", { projectId: projectB, parentThreadId: spanning.id });
    // All children elsewhere still spans two projects: the coordinator's and theirs.
    const remote = thread("remote", { projectId: projectA });
    const remoteChild = thread("r1", { projectId: projectB, parentThreadId: remote.id });
    const threads = [local, localChild, spanning, sameChild, otherChild, remote, remoteChild];
    const keys = crossProjectCoordinatorKeys({ threads, groups: groupChildThreads(threads) });
    expect([...keys].toSorted()).toEqual([key("remote"), key("spanning")].toSorted());
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
