import type { VcsCommitGraphEntry } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { layoutCommitGraph, type CommitGraphLayout } from "./commitGraphLayout";

const commit = (sha: string, parents: ReadonlyArray<string>): VcsCommitGraphEntry => ({
  sha,
  parents,
  refs: [],
  author: "Test",
  authoredAt: "2026-09-18T10:00:00+02:00",
  subject: sha,
});

const layout = (commits: ReadonlyArray<VcsCommitGraphEntry>) =>
  layoutCommitGraph(commits, { colorCount: 8 });

/**
 * Two branches off `base`, each merged back — the shape that strands edges when
 * lanes wait for commits instead of edges owning lanes.
 *
 *   merge-b  ──┐
 *   merge-a  ─┐│
 *   b         ││
 *   a         ││
 *   base     ←┴┘
 */
const twoBranchesRejoining: ReadonlyArray<VcsCommitGraphEntry> = [
  commit("merge-b", ["merge-a", "b"]),
  commit("merge-a", ["base", "a"]),
  commit("b", ["base"]),
  commit("a", ["base"]),
  commit("base", ["root"]),
  commit("root", []),
];

const rowOf = (result: CommitGraphLayout, sha: string) =>
  result.rows.find((row) => row.commit.sha === sha);

describe("layoutCommitGraph", () => {
  it("ends every edge on the row and lane its parent was drawn in", () => {
    const result = layout(twoBranchesRejoining);
    for (const edge of result.edges) {
      if (edge.to === null) continue;
      const parent = rowOf(result, edge.to);
      assert.ok(parent !== undefined, `parent ${edge.to} is in the window`);
      assert.strictEqual(
        edge.endRow,
        parent?.row,
        `edge ${edge.from} -> ${edge.to} ends on its parent's row`,
      );
      assert.strictEqual(
        edge.endLane,
        parent?.lane,
        `edge ${edge.from} -> ${edge.to} ends in its parent's lane`,
      );
      assert.strictEqual(edge.open, false);
    }
  });

  it("never lets two edges hold the same lane at the same time", () => {
    const result = layout(twoBranchesRejoining);
    for (const [index, edge] of result.edges.entries()) {
      for (const other of result.edges.slice(index + 1)) {
        if (other.lane !== edge.lane) continue;
        const overlap =
          Math.min(edge.endRow, other.endRow) - Math.max(edge.startRow, other.startRow);
        assert.ok(
          overlap <= 0,
          `lane ${edge.lane} is held by ${edge.from} and ${other.from} at once`,
        );
      }
    }
  });

  it("draws a commit in a lane that at least one of its incoming edges arrives in", () => {
    const result = layout(twoBranchesRejoining);
    for (const row of result.rows) {
      const incoming = result.edges.filter((edge) => edge.to === row.commit.sha);
      if (incoming.length === 0) continue;
      assert.ok(
        incoming.some((edge) => edge.endLane === row.lane),
        `commit ${row.commit.sha} sits on an incoming lane`,
      );
    }
  });

  it("converges every branch that rejoins on the same commit", () => {
    const result = layout(twoBranchesRejoining);
    const base = rowOf(result, "base");
    const intoBase = result.edges.filter((edge) => edge.to === "base");
    assert.strictEqual(intoBase.length, 3, "merge-a, a and b all point at base");
    assert.ok(
      intoBase.every((edge) => edge.endLane === base?.lane),
      "all three edges end in base's lane",
    );
    assert.ok(
      new Set(intoBase.map((edge) => edge.lane)).size === 3,
      "they travel in three separate lanes before converging",
    );
  });

  it("keeps a line's colour where several branches rejoin", () => {
    const result = layout(twoBranchesRejoining);
    // merge-b, merge-a and base all sit in lane 0 and must read as one line.
    assert.strictEqual(rowOf(result, "merge-b")?.lane, 0);
    assert.strictEqual(rowOf(result, "base")?.color, rowOf(result, "merge-b")?.color);
  });

  it("marks an edge as open when its parent is behind the window", () => {
    const result = layout([commit("head", ["cut-off"])]);
    assert.strictEqual(result.edges.length, 1);
    assert.strictEqual(result.edges[0]?.open, true);
    assert.strictEqual(result.edges[0]?.endRow, 1, "it runs off the bottom of the window");
  });

  it("leaves a root commit without any edge", () => {
    const result = layout([commit("root", [])]);
    assert.deepStrictEqual(result.edges, []);
    assert.strictEqual(result.laneCount, 1);
  });

  it("gives disconnected histories their own lanes", () => {
    const result = layout([commit("a", []), commit("b", [])]);
    assert.strictEqual(rowOf(result, "a")?.lane, 0);
    assert.strictEqual(rowOf(result, "b")?.lane, 0, "a finished lane is reused, not stacked");
    assert.strictEqual(result.laneCount, 1);
  });

  it("keeps all parents of an octopus merge", () => {
    const result = layout([
      commit("octopus", ["p1", "p2", "p3"]),
      commit("p1", []),
      commit("p2", []),
      commit("p3", []),
    ]);
    assert.strictEqual(result.edges.length, 3);
    assert.strictEqual(new Set(result.edges.map((edge) => edge.lane)).size, 3);
    assert.strictEqual(rowOf(result, "octopus")?.isMerge, true);
  });

  it("handles an empty history", () => {
    assert.deepStrictEqual(layout([]), { rows: [], edges: [], laneCount: 0 });
  });
});
