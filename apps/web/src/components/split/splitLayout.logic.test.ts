import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGridLayout,
  closeLeaf,
  computeLayout,
  dropExistingLeaf,
  dropNewThread,
  equalizeBranch,
  gridColumnCounts,
  listLeaves,
  recommendGrid,
  resizeBranch,
  resolveDropZone,
  sanitizeLayout,
  SINGLE_PANE_LAYOUT,
  type SplitNode,
} from "./splitLayout.logic";

const thread = (id: string): ScopedThreadRef => ({
  environmentId: "env" as EnvironmentId,
  threadId: id as ThreadId,
});

const shape = (node: SplitNode): unknown =>
  node.kind === "leaf"
    ? node.id
    : { [node.direction]: node.children.map(shape), sizes: node.sizes.map((s) => +s.toFixed(3)) };

let counter = 0;
const ids = () => ({ newLeafId: `leaf-${++counter}`, newBranchId: `branch-${counter}` });

describe("split layout", () => {
  it("splits the route pane to the right and below", () => {
    counter = 0;
    let layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    layout = dropNewThread(layout, {
      targetLeafId: "leaf-1",
      zone: "bottom",
      thread: thread("b"),
      ...ids(),
    });
    expect(shape(layout)).toEqual({
      row: ["route", { column: ["leaf-1", "leaf-2"], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    });
  });

  it("adds a sibling instead of nesting when the direction matches", () => {
    counter = 0;
    let layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    layout = dropNewThread(layout, {
      targetLeafId: "leaf-1",
      zone: "right",
      thread: thread("b"),
      ...ids(),
    });
    expect(shape(layout)).toEqual({ row: ["route", "leaf-1", "leaf-2"], sizes: [0.5, 0.25, 0.25] });
  });

  it("moves an existing pane and collapses the branch it left", () => {
    counter = 0;
    let layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    layout = dropNewThread(layout, {
      targetLeafId: "leaf-1",
      zone: "bottom",
      thread: thread("b"),
      ...ids(),
    });
    layout = dropExistingLeaf(layout, {
      sourceLeafId: "leaf-2",
      targetLeafId: "route",
      zone: "top",
      newBranchId: "moved",
    });
    expect(shape(layout)).toEqual({
      row: [{ column: ["leaf-2", "route"], sizes: [0.5, 0.5] }, "leaf-1"],
      sizes: [0.5, 0.5],
    });
  });

  it("swaps panes when dropped on the centre", () => {
    counter = 0;
    const layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    const swapped = dropExistingLeaf(layout, {
      sourceLeafId: "leaf-1",
      targetLeafId: "route",
      zone: "center",
      newBranchId: "unused",
    });
    expect(shape(swapped)).toEqual({ row: ["leaf-1", "route"], sizes: [0.5, 0.5] });
  });

  it("closes a pane and gives its space back", () => {
    counter = 0;
    const layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    expect(closeLeaf(layout, "leaf-1")).toEqual({ layout: SINGLE_PANE_LAYOUT, navigateTo: null });
  });

  it("promotes the neighbour when the route pane closes", () => {
    counter = 0;
    let layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    layout = dropNewThread(layout, {
      targetLeafId: "leaf-1",
      zone: "right",
      thread: thread("b"),
      ...ids(),
    });
    const closed = closeLeaf(layout, "route");
    expect(closed.navigateTo).toEqual(thread("a"));
    expect(shape(closed.layout)).toEqual({ row: ["route", "leaf-2"], sizes: [0.5, 0.5] });
    expect(listLeaves(closed.layout).filter((leaf) => leaf.thread === "route")).toHaveLength(1);
  });

  it("keeps a single route pane open", () => {
    expect(closeLeaf(SINGLE_PANE_LAYOUT, "route").layout).toBe(SINGLE_PANE_LAYOUT);
  });

  it("clamps resizing to the minimum pane size", () => {
    counter = 0;
    const layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "bottom",
      thread: thread("a"),
      ...ids(),
    });
    const branchId = layout.id;
    expect(shape(resizeBranch(layout, branchId, 0, 0.98))).toEqual({
      column: ["route", "leaf-1"],
      sizes: [0.9, 0.1],
    });
  });

  it("equalizes the children of a branch", () => {
    counter = 0;
    let layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "right",
      thread: thread("a"),
      ...ids(),
    });
    layout = dropNewThread(layout, {
      targetLeafId: "leaf-1",
      zone: "right",
      thread: thread("b"),
      ...ids(),
    });
    expect(shape(equalizeBranch(layout, layout.id))).toEqual({
      row: ["route", "leaf-1", "leaf-2"],
      sizes: [0.333, 0.333, 0.333],
    });
  });

  it("lays out panes and dividers in unit coordinates", () => {
    counter = 0;
    const layout = dropNewThread(SINGLE_PANE_LAYOUT, {
      targetLeafId: "route",
      zone: "left",
      thread: thread("a"),
      ...ids(),
    });
    const { panes, dividers } = computeLayout(layout);
    expect(panes.map((pane) => [pane.leaf.id, pane.rect.left, pane.rect.width])).toEqual([
      ["leaf-1", 0, 0.5],
      ["route", 0.5, 0.5],
    ]);
    expect(dividers).toHaveLength(1);
    expect(dividers[0]!.rect.left).toBe(0.5);
  });

  it("targets edges in the outer third and the centre otherwise", () => {
    expect(resolveDropZone(0.1, 0.5)).toBe("left");
    expect(resolveDropZone(0.5, 0.9)).toBe("bottom");
    expect(resolveDropZone(0.5, 0.5)).toBe("center");
  });

  it("falls back to a single pane for corrupt persisted layouts", () => {
    expect(sanitizeLayout(null)).toBe(SINGLE_PANE_LAYOUT);
    expect(
      sanitizeLayout({
        kind: "split",
        id: "x",
        direction: "row",
        children: [
          { kind: "leaf", id: "a", thread: thread("a") },
          { kind: "leaf", id: "b", thread: thread("b") },
        ],
        sizes: [0.5, 0.5],
      }),
    ).toBe(SINGLE_PANE_LAYOUT);
  });
});

describe("auto arrange", () => {
  const area = { width: 1450, height: 950 };

  it("suggests grids that give every session the most room", () => {
    expect(recommendGrid(4, area.width, area.height)).toEqual({ columns: 2, rows: 2 });
    expect(recommendGrid(4, 1700, area.height)).toEqual({ columns: 4, rows: 1 });
    expect(recommendGrid(5, area.width, area.height)).toEqual({ columns: 3, rows: 2 });
    expect(recommendGrid(12, 1700, area.height)).toEqual({ columns: 4, rows: 3 });
    expect(recommendGrid(1, area.width, area.height)).toEqual({ columns: 1, rows: 1 });
  });

  it("caps the grid at the minimum pane size when sessions do not fit", () => {
    expect(recommendGrid(30, area.width, area.height)).toEqual({ columns: 3, rows: 3 });
  });

  it("puts the shorter columns first", () => {
    expect(gridColumnCounts(5, { columns: 3, rows: 2 })).toEqual([1, 2, 2]);
    expect(gridColumnCounts(12, { columns: 4, rows: 3 })).toEqual([3, 3, 3, 3]);
    expect(gridColumnCounts(3, { columns: 5, rows: 2 })).toEqual([1, 1, 1]);
    expect(gridColumnCounts(9, { columns: 2, rows: 2 })).toEqual([2, 2]);
  });

  it("builds columns of panes and keeps the routed thread in the route pane", () => {
    let id = 0;
    const threads = ["a", "b", "c", "d", "e"].map(thread);
    const { layout, navigateTo } = buildGridLayout({
      threads,
      routeThread: thread("c"),
      grid: { columns: 3, rows: 2 },
      makeId: (prefix) => `${prefix}-${++id}`,
    });
    expect(navigateTo).toBeNull();
    const leaves = listLeaves(layout);
    expect(
      leaves.map((leaf) => (leaf.thread === "route" ? "route" : leaf.thread.threadId)),
    ).toEqual(["a", "b", "route", "d", "e"]);
    expect(layout.kind === "split" && layout.direction).toBe("row");
    expect(layout.kind === "split" && layout.children.map((child) => child.kind)).toEqual([
      "leaf",
      "split",
      "split",
    ]);
  });

  it("routes to the first session when the open thread is not arranged", () => {
    const { layout, navigateTo } = buildGridLayout({
      threads: [thread("a"), thread("b")],
      routeThread: thread("z"),
      grid: { columns: 2, rows: 1 },
      makeId: (prefix) => prefix,
    });
    expect(navigateTo).toEqual(thread("a"));
    expect(listLeaves(layout)[0]!.thread).toBe("route");
  });
});
