import { assert, describe, it } from "vite-plus/test";

import type { CommitGraphEdge } from "./commitGraphLayout";
import { edgePath, laneX } from "./edgePath";

const edge = (overrides: Partial<CommitGraphEdge>): CommitGraphEdge => ({
  from: "child",
  to: "parent",
  startRow: 0,
  startLane: 0,
  lane: 0,
  endRow: 3,
  endLane: 0,
  firstParent: true,
  color: 0,
  open: false,
  ...overrides,
});

/** Every x the path visits, in order. */
const xs = (path: string) =>
  [...path.matchAll(/[ML] ?(-?[\d.]+)|C(?:\s*-?[\d.]+ -?[\d.]+){2}\s*(-?[\d.]+)/g)].map((match) =>
    Number(match[1] ?? match[2]),
  );

describe("edgePath", () => {
  it("routes a long edge through its own lane", () => {
    const path = edgePath(edge({ startLane: 0, lane: 2, endLane: 1, endRow: 6 }));
    assert.ok(xs(path).includes(laneX(2)), "the path visits the lane the layout reserved");
  });

  it("bends a merge straight into a parent one row below instead of looping out", () => {
    // The shape that used to draw a loop: a merge whose second parent is the
    // very next row, holding a lane of its own to the right of both ends.
    const path = edgePath(edge({ startRow: 1, startLane: 1, lane: 2, endRow: 2, endLane: 0 }));
    const visited = xs(path);
    assert.ok(!visited.includes(laneX(2)), "it never detours into the reserved lane");
    assert.deepStrictEqual(
      [...new Set(visited)],
      [laneX(1), laneX(0)],
      "it leaves the child's lane and lands in the parent's",
    );
  });

  it("draws a straight line when both ends share a lane", () => {
    const path = edgePath(edge({ startLane: 1, lane: 1, endLane: 1 }));
    assert.ok(!path.includes("C"), "no bends");
    assert.deepStrictEqual([...new Set(xs(path))], [laneX(1)]);
  });
});
