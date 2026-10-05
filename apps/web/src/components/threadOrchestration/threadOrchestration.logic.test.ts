import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import { describe, expect, it } from "vite-plus/test";

import {
  crossProjectCoordinatorKeys,
  groupChildThreads,
  hiddenChildThreadGroups,
  sidebarRowsWithCoordinators,
  visibleChildThreads,
} from "./childThreads.logic";
import {
  buildThreadOverview,
  describeOverviewOrigin,
  subagentThreadsOf,
  threadOverviewEntries,
  waitingThreadCount,
} from "./threadOverview.logic";

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

  it("hides every child of a listed coordinator while the sidebar setting is off", () => {
    const coordinator = thread("coord");
    const linked = thread("l1");
    const orphan = thread("o1");
    const threads = [coordinator, delegated("c1", "coord"), linked, orphan];
    const coordinatorOf = adopted([
      ["l1", "coord"],
      ["o1", "gone"],
    ]);
    const rows = sidebarRowsWithCoordinators([coordinator, linked, orphan], {
      threads,
      scopedProjectKeys: null,
      groups: hiddenChildThreadGroups(threads, coordinatorOf),
    });
    expect(rows.map((t) => t.id)).toEqual(["coord", "o1"]);
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
  it("orders sections by what the user acts on first, splits finished ones by settlement and leaves empty ones out", () => {
    const children = [
      thread("done", {}, { status: "completed" }),
      thread("settled", { settledOverride: "settled" }, { status: "completed" }),
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
    const entries = threadOverviewEntries({ children, subagentThreads: [], subagents: new Map() });
    const groups = buildThreadOverview(entries);
    expect(groups.map((group) => [group.id, group.entries.map((e) => e.thread.id)])).toEqual([
      ["waiting", expect.arrayContaining(["failed", "asks"])],
      ["working", ["working"]],
      ["active", ["done"]],
      ["settled", ["settled"]],
    ]);
    expect(waitingThreadCount(entries)).toBe(2);
    expect(describeOverviewOrigin(entries)).toBe("5 threads coordinated from here");
  });

  it("lists a settled thread with an open pull request as settled, not ready for review", () => {
    const openPullRequest = {
      pullRequests: [
        {
          host: "github.com",
          repository: "esveo/t3code",
          number: 7,
          url: "https://github.com/esveo/t3code/pull/7",
          source: "agent",
          linkedAt: "2026-09-23T10:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ],
    } as Partial<OrchestrationV2ThreadShell>;
    const children = [
      thread("review", {}, { status: "completed", ...openPullRequest }),
      thread(
        "settled",
        { settledOverride: "settled" },
        { status: "completed", ...openPullRequest },
      ),
    ];
    const entries = threadOverviewEntries({ children, subagentThreads: [], subagents: new Map() });
    expect(
      buildThreadOverview(entries).map((group) => [
        group.id,
        group.entries.map((e) => e.thread.id),
      ]),
    ).toEqual([
      ["review", ["review"]],
      ["settled", ["settled"]],
    ]);
  });

  /** A subagent Claude Code's Agent tool started, with its own thread. */
  const nativeSubagent = (
    id: string,
    parent: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ) => {
    const lineage = {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make(parent),
    };
    return thread(id, { lineage, ...overrides }, { lineage, creationSource: "provider" });
  };
  const snapshot = (status: "running" | "waiting" | "failed" | "completed" | "interrupted") => ({
    status,
    updatedAt: "2026-09-23T11:00:00.000Z",
  });

  it("lists the agent's own subagents beside its threads, once each", () => {
    const threads = [
      thread("coord"),
      delegated("child", "coord"),
      nativeSubagent("agent", "coord"),
      nativeSubagent("elsewhere", "other"),
      nativeSubagent("archived", "coord", { archivedAt: "2026-09-23T10:00:00.000Z" }),
      nativeSubagent("moved", "coord"),
      nativeSubagent("adopted", "coord"),
    ];
    const lookup = adopted([
      ["moved", "other"],
      ["adopted", "coord"],
    ]);
    const parent = { environmentId: ENV, id: ThreadId.make("coord") };
    const children = threads.filter((shell) => lookup(shell) === parent.id);
    const entries = threadOverviewEntries({
      children,
      subagentThreads: subagentThreadsOf(threads, parent, lookup),
      subagents: new Map(),
    });
    expect(entries.map((entry) => [entry.thread.id, entry.kind])).toEqual([
      ["child", "thread"],
      ["adopted", "thread"],
      ["agent", "subagent"],
    ]);
    expect(describeOverviewOrigin(entries)).toBe("2 threads and 1 subagent started from here");
  });

  it("sorts subagents by the status of their record, as their threads have no runs", () => {
    const subagentThreads = [
      nativeSubagent("running", "coord"),
      nativeSubagent("asks", "coord"),
      nativeSubagent("failed", "coord"),
      nativeSubagent("finished", "coord"),
      nativeSubagent("stopped", "coord", { settledOverride: "settled" }),
      nativeSubagent("unknown", "coord"),
    ];
    const subagents = new Map([
      [ThreadId.make("running"), snapshot("running")],
      [ThreadId.make("asks"), snapshot("waiting")],
      [ThreadId.make("failed"), snapshot("failed")],
      [ThreadId.make("finished"), snapshot("completed")],
      [ThreadId.make("stopped"), snapshot("interrupted")],
    ]);
    const entries = threadOverviewEntries({ children: [], subagentThreads, subagents });
    const groups = buildThreadOverview(entries);
    expect(groups.map((group) => [group.id, group.entries.map((e) => e.thread.id)])).toEqual([
      ["waiting", expect.arrayContaining(["asks", "failed"])],
      ["working", ["running"]],
      ["active", expect.arrayContaining(["finished", "unknown"])],
      ["settled", ["stopped"]],
    ]);
    expect(waitingThreadCount(entries)).toBe(2);
    // The record's activity counts, the idle thread shell's does not.
    expect(entries.find((entry) => entry.thread.id === "running")?.updatedAt).toBe(
      "2026-09-23T11:00:00.000Z",
    );
  });

  it("lets a request pending on a subagent's thread win over its record", () => {
    const asking = nativeSubagent("asking", "coord");
    const withRequest = {
      ...asking,
      source: {
        ...asking.source,
        pendingRuntimeRequest: {
          kind: "command",
        } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
      },
    };
    const [entry] = threadOverviewEntries({
      children: [],
      subagentThreads: [withRequest],
      subagents: new Map([[ThreadId.make("asking"), snapshot("running")]]),
    });
    expect([entry?.state, entry?.detail]).toEqual(["waiting", "Needs your approval"]);
  });
});
