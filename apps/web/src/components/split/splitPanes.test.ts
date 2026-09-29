import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useSplitThreadStore } from "../../splitThreadStore";
import { findLeaf, ROUTE_LEAF_ID, SINGLE_PANE_LAYOUT, type SplitNode } from "./splitLayout.logic";
import { openThreadInPane } from "./splitPanes";

const thread = (threadId: string): ScopedThreadRef => ({
  environmentId: "env-1" as EnvironmentId,
  threadId: threadId as ThreadId,
});

const splitLayout: SplitNode = {
  kind: "split",
  id: "split-1",
  direction: "row",
  children: [
    { kind: "leaf", id: ROUTE_LEAF_ID, thread: "route" },
    { kind: "leaf", id: "pane-a", thread: thread("parent") },
    { kind: "leaf", id: "pane-b", thread: thread("other") },
  ],
  sizes: [1 / 3, 1 / 3, 1 / 3],
};

function reset(layout: SplitNode) {
  useSplitThreadStore.setState({
    layout,
    activeLeafId: ROUTE_LEAF_ID,
    routeThread: thread("routed"),
  });
}

describe("openThreadInPane", () => {
  beforeEach(() => reset(splitLayout));

  it("shows the thread in the pane it was opened from", () => {
    expect(openThreadInPane("pane-a", thread("subagent"))).toBe(true);
    const { layout, activeLeafId } = useSplitThreadStore.getState();
    expect(findLeaf(layout, "pane-a")?.thread).toEqual(thread("subagent"));
    expect(findLeaf(layout, "pane-b")?.thread).toEqual(thread("other"));
    expect(activeLeafId).toBe("pane-a");
  });

  it("focuses a pane that already shows the thread instead of duplicating it", () => {
    expect(openThreadInPane("pane-a", thread("other"))).toBe(true);
    expect(openThreadInPane("pane-b", thread("routed"))).toBe(true);
    const { layout, activeLeafId } = useSplitThreadStore.getState();
    expect(layout).toBe(splitLayout);
    expect(activeLeafId).toBe(ROUTE_LEAF_ID);
  });

  it("leaves the route pane and a single view to navigation", () => {
    expect(openThreadInPane(ROUTE_LEAF_ID, thread("subagent"))).toBe(false);
    reset(SINGLE_PANE_LAYOUT);
    expect(openThreadInPane(ROUTE_LEAF_ID, thread("subagent"))).toBe(false);
    expect(useSplitThreadStore.getState().layout).toBe(SINGLE_PANE_LAYOUT);
  });
});
