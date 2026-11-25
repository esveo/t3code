import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { descendantThreadsOf } from "../threadOrchestration/threadOverview.logic";
import {
  waitingForYouIndex,
  waitingForYouKey,
  waitingThreadIdsOf,
  withWaitingForYou,
} from "./waitingForYou.logic";

const ENV = EnvironmentId.make("env-1");
const asking = (at: number) => ({
  id: RuntimeRequestId.make(`question-${at}`),
  createdAt: DateTime.makeUnsafe(at),
});
const thread = (
  id: string,
  parent: string | null,
  pendingRuntimeRequest: ReturnType<typeof asking> | null = null,
): EnvironmentThreadShell => {
  const lineage = {
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    relationshipToParent: parent === null ? null : ("subagent" as const),
    rootThreadId: ThreadId.make(parent ?? id),
  };
  return {
    id: ThreadId.make(id),
    environmentId: ENV,
    archivedAt: null,
    source: {
      id: ThreadId.make(id),
      creationSource: parent === null ? "web" : "mcp",
      lineage,
      pendingRuntimeRequest,
    },
  } as unknown as EnvironmentThreadShell;
};

const threads = [
  thread("coordinator", null),
  thread("child", "coordinator", asking(2)),
  thread("grandchild", "child", asking(1)),
  thread("other", null),
];
const waitingFor = (index: ReadonlyMap<string, string>, id: string) =>
  waitingThreadIdsOf(index.get(waitingForYouKey(ENV, ThreadId.make(id))) ?? "");

describe("waiting for you", () => {
  it("lists every waiting thread below a thread, oldest first", () => {
    const index = waitingForYouIndex(threads, new Map());
    expect(waitingFor(index, "coordinator")).toEqual(["grandchild", "child"]);
    expect(waitingFor(index, "child")).toEqual(["grandchild"]);
    expect(waitingFor(index, "grandchild")).toEqual([]);
    expect(waitingFor(index, "other")).toEqual([]);
  });

  it("follows a coordinator link and clears once nothing waits", () => {
    const adopted = waitingForYouIndex(
      threads,
      new Map([[ENV, new Map([[ThreadId.make("child"), ThreadId.make("other")]])]]),
    );
    expect(waitingFor(adopted, "other")).toEqual(["grandchild", "child"]);
    expect(waitingFor(adopted, "coordinator")).toEqual([]);
    expect(
      waitingForYouIndex([thread("coordinator", null), thread("child", "coordinator")], new Map())
        .size,
    ).toBe(0);
  });

  it("outranks the thread's own work but not its own request or failure", () => {
    const waiting = [ThreadId.make("child")];
    for (const status of ["preparing", "working", "waiting", "ready"] as const) {
      expect(withWaitingForYou(status, waiting)).toBe("input");
    }
    for (const status of ["approval", "input", "request", "failed", "limited"] as const) {
      expect(withWaitingForYou(status, waiting)).toBe(status);
    }
    expect(withWaitingForYou("working", [])).toBe("working");
  });

  it("finds the coordinator's descendants for its inbox", () => {
    const coordinatorOf = (shell: Pick<EnvironmentThreadShell, "source">) =>
      coordinatorThreadIdOf(shell.source, new Map());
    expect(
      descendantThreadsOf(threads, threads[0]!, coordinatorOf).map((child) => child.id),
    ).toEqual(["child", "grandchild"]);
  });
});
