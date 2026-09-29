import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import { describe, expect, it } from "vite-plus/test";

import {
  crossProjectCoordinatorKeys,
  groupChildThreads,
  sidebarRowsWithCoordinators,
  visibleChildThreads,
} from "./childThreads.logic";
import { buildThreadOverview, waitingThreadCount } from "./threadOverview.logic";

const ENV = EnvironmentId.make("env-1");
type Source = Partial<OrchestrationV2ThreadShell>;
const thread = (
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
  source: Source = {},
): EnvironmentThreadShell =>
  ({
    id: ThreadId.make(id),
    environmentId: ENV,
    projectId: "project-a",
    archivedAt: null,
    createdAt: `2026-09-23T10:00:0${id.length % 10}.000Z`,
    updatedAt: "2026-09-23T10:00:00.000Z",
    lineage: source.lineage ?? {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: id,
    },
    source: {
      id: ThreadId.make(id),
      creationSource: "web",
      status: "idle",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      lastError: null,
      pullRequests: [],
      pendingBackgroundTasks: [],
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      ...source,
    },
    ...overrides,
  }) as EnvironmentThreadShell;
/** A thread the coordinator started with delegate_task. */
const delegated = (
  id: string,
  coordinator: string,
  overrides: Partial<EnvironmentThreadShell> = {},
) => {
  const lineage = {
    parentThreadId: ThreadId.make(coordinator),
    relationshipToParent: "subagent" as const,
    rootThreadId: ThreadId.make(coordinator),
  };
  return thread(id, { lineage, ...overrides }, { lineage, creationSource: "mcp" });
};
const key = (id: string) => scopedThreadKey(scopeThreadRef(ENV, ThreadId.make(id)));
const coordinatorOf =
  (overrides: ReadonlyMap<ThreadId, ThreadId | null> = new Map()) =>
  (shell: Pick<EnvironmentThreadShell, "source">) =>
    coordinatorThreadIdOf(shell.source, overrides);
const adopted = (entries: ReadonlyArray<[string, string | null]>) =>
  coordinatorOf(
    new Map(
      entries.map(([child, parent]) => [
        ThreadId.make(child),
        parent === null ? null : ThreadId.make(parent),
      ]),
    ),
  );

describe("groupChildThreads", () => {
  it("nests delegated and adopted children under a listed coordinator and frees orphans", () => {
    const coordinator = thread("coord");
    const child = delegated("c1", "coord");
    const orphan = delegated("c2", "gone");
    const archivedParent = thread("old", { archivedAt: "2026-09-22T00:00:00.000Z" });
    const childOfArchived = delegated("c3", "old");
    const assigned = thread("a1");

    const groups = groupChildThreads(
      [coordinator, child, orphan, archivedParent, childOfArchived, assigned],
      adopted([["a1", "coord"]]),
    );
    expect(groups.childrenByParentKey.get(key("coord"))?.map((t) => t.id)).toEqual(["c1", "a1"]);
    expect([...groups.nestedThreadKeys].toSorted()).toEqual([key("a1"), key("c1")].toSorted());
  });

  it("follows a released or moved child", () => {
    const coordinator = thread("coord");
    const other = thread("other");
    const released = delegated("c1", "coord");
    const moved = delegated("c2", "coord");
    const groups = groupChildThreads(
      [coordinator, other, released, moved],
      adopted([
        ["c1", null],
        ["c2", "other"],
      ]),
    );
    expect(groups.childrenByParentKey.has(key("coord"))).toBe(false);
    expect(groups.childrenByParentKey.get(key("other"))?.map((t) => t.id)).toEqual(["c2"]);
  });

  it("lists a settled child on the settled shelf, not under its open coordinator", () => {
    const coordinator = thread("coord");
    const openChild = delegated("c1", "coord");
    const settledChild = delegated("c2", "coord", { settledOverride: "settled" });
    const groups = groupChildThreads([coordinator, openChild, settledChild], coordinatorOf());
    expect(groups.childrenByParentKey.get(key("coord"))?.map((t) => t.id)).toEqual(["c1"]);
    expect(groups.nestedThreadKeys.has(key("c2"))).toBe(false);

    // Settled together, they nest again on the settled shelf.
    const settledCoordinator = { ...coordinator, settledOverride: "settled" as const };
    const together = groupChildThreads([settledCoordinator, settledChild], coordinatorOf());
    expect(together.childrenByParentKey.get(key("coord"))?.map((t) => t.id)).toEqual(["c2"]);
  });

  it("keeps a folded group's children that need the user or are open", () => {
    const children = [
      thread("working", {}, { status: "running" }),
      thread(
        "waiting",
        {},
        {
          pendingRuntimeRequest: {
            kind: "user_input",
          } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
        },
      ),
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

describe("sidebarRowsWithCoordinators", () => {
  it("drops nested children and gives delegated threads without a group their own row", () => {
    const coordinator = thread("coord");
    const nested = delegated("c1", "coord");
    const released = delegated("c2", "coord");
    const providerSubagent = thread(
      "p1",
      {
        lineage: {
          parentThreadId: ThreadId.make("coord"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("coord"),
        },
      },
      { creationSource: "provider" },
    );
    const threads = [coordinator, nested, released, providerSubagent];
    const groups = groupChildThreads(threads, adopted([["c2", null]]));
    // The sidebar's own filter lists top-level threads only.
    const rows = sidebarRowsWithCoordinators([coordinator], {
      threads,
      scopedProjectKeys: null,
      groups,
    });
    expect(rows.map((t) => t.id)).toEqual(["coord", "c2"]);
  });
});

describe("crossProjectCoordinatorKeys", () => {
  it("moves a coordinator out of its project once its work spans projects", () => {
    const projectA = "project-a" as EnvironmentThreadShell["projectId"];
    const projectB = "project-b" as EnvironmentThreadShell["projectId"];
    const local = thread("local", { projectId: projectA });
    const localChild = delegated("lc", "local", { projectId: projectA });
    const spanning = thread("spanning", { projectId: projectA });
    const sameChild = delegated("s1", "spanning", { projectId: projectA });
    const otherChild = delegated("s2", "spanning", { projectId: projectB });
    // All children elsewhere still spans two projects: the coordinator's and theirs.
    const remote = thread("remote", { projectId: projectA });
    const remoteChild = delegated("r1", "remote", { projectId: projectB });
    const threads = [local, localChild, spanning, sameChild, otherChild, remote, remoteChild];
    const keys = crossProjectCoordinatorKeys({
      threads,
      groups: groupChildThreads(threads, coordinatorOf()),
    });
    expect([...keys].toSorted()).toEqual([key("remote"), key("spanning")].toSorted());
  });
});

describe("buildThreadOverview", () => {
  it("orders sections by what the user acts on first and leaves empty ones out", () => {
    const children = [
      thread("done", {}, { status: "completed" }),
      thread("failed", {}, { status: "failed" }),
      thread("working", {}, { status: "running" }),
      thread(
        "asks",
        {},
        {
          pendingRuntimeRequest: {
            kind: "command",
          } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
        },
      ),
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
