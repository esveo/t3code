import type { VcsCommitGraphEntry } from "@t3tools/contracts";

/**
 * Turns a commit list into lanes and edges for the graph view.
 *
 * Edges own lanes, not commits: every child -> parent edge holds its lane from
 * the moment it appears until its parent is drawn, then bends into whichever
 * lane that parent ended up on. Letting lanes wait for a commit instead would
 * strand every edge but the first when several branches rejoin at one commit.
 *
 * Commits are expected newest-first, the order `git log` returns them in.
 */

export interface CommitGraphEdge {
  readonly from: string;
  /** Null when the parent lies behind the loaded window. */
  readonly to: string | null;
  readonly startRow: number;
  readonly startLane: number;
  /** The lane the edge travels in between its two ends. */
  readonly lane: number;
  readonly endRow: number;
  readonly endLane: number;
  readonly firstParent: boolean;
  readonly color: number;
  /** True when the edge leaves the window rather than reaching its parent. */
  readonly open: boolean;
}

export interface CommitGraphRow {
  readonly commit: VcsCommitGraphEntry;
  readonly row: number;
  readonly lane: number;
  readonly color: number;
  readonly isMerge: boolean;
}

export interface CommitGraphLayout {
  readonly rows: ReadonlyArray<CommitGraphRow>;
  readonly edges: ReadonlyArray<CommitGraphEdge>;
  readonly laneCount: number;
}

interface MutableEdge {
  from: string;
  to: string | null;
  startRow: number;
  startLane: number;
  lane: number;
  endRow: number | null;
  endLane: number | null;
  firstParent: boolean;
  color: number;
  open: boolean;
}

export function layoutCommitGraph(
  commits: ReadonlyArray<VcsCommitGraphEntry>,
  options: { readonly colorCount: number },
): CommitGraphLayout {
  const colorCount = Math.max(1, options.colorCount);
  const rowBySha = new Map(commits.map((commit, row) => [commit.sha, row]));
  const lanes: Array<MutableEdge | null> = [];
  const edges: MutableEdge[] = [];
  const rows: CommitGraphRow[] = [];
  let nextColor = 0;
  let maxLane = 0;

  const takeColor = () => {
    const color = nextColor % colorCount;
    nextColor += 1;
    return color;
  };
  const allocateLane = (edge: MutableEdge | null) => {
    const free = lanes.findIndex((slot) => slot === null);
    const lane = free === -1 ? lanes.length : free;
    lanes[lane] = edge;
    maxLane = Math.max(maxLane, lane);
    return lane;
  };
  const openEdge = (edge: Omit<MutableEdge, "lane">, lane: number) => {
    const placed: MutableEdge = { ...edge, lane };
    lanes[lane] = placed;
    edges.push(placed);
    maxLane = Math.max(maxLane, lane);
  };

  commits.forEach((commit, row) => {
    const incoming = edges.filter((edge) => edge.to === commit.sha && edge.endRow === null);
    // A commit sits in the leftmost lane that leads to it; the other lanes
    // bend into that one here and are released.
    const lane =
      incoming.length > 0 ? Math.min(...incoming.map((edge) => edge.lane)) : allocateLane(null);
    for (const edge of incoming) {
      edge.endRow = row;
      edge.endLane = lane;
      lanes[edge.lane] = null;
    }
    maxLane = Math.max(maxLane, lane);

    // The colour comes from the edge arriving in *this* lane, so a line running
    // straight down keeps its colour where several branches rejoin.
    const onLane = incoming.filter((edge) => edge.lane === lane);
    const color =
      onLane.find((edge) => edge.firstParent)?.color ??
      onLane[0]?.color ??
      incoming[0]?.color ??
      takeColor();

    const knownParents = commit.parents.filter((parent) => rowBySha.has(parent));
    knownParents.forEach((parent, index) => {
      const base = {
        from: commit.sha,
        to: parent,
        startRow: row,
        startLane: lane,
        endRow: null,
        endLane: null,
        firstParent: index === 0,
        color: index === 0 ? color : takeColor(),
        open: false,
      };
      // The first parent continues in the commit's own lane; merge parents branch off.
      openEdge(base, index === 0 ? lane : allocateLane(null));
    });

    if (knownParents.length === 0) {
      lanes[lane] = null;
      if (commit.parents.length > 0) {
        // The parent exists but sits behind the window: the lane leaves the view.
        openEdge(
          {
            from: commit.sha,
            to: null,
            startRow: row,
            startLane: lane,
            endRow: null,
            endLane: null,
            firstParent: true,
            color,
            open: true,
          },
          lane,
        );
      }
    }

    rows.push({ commit, row, lane, color, isMerge: commit.parents.length > 1 });
  });

  const resolved: CommitGraphEdge[] = edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    startRow: edge.startRow,
    startLane: edge.startLane,
    lane: edge.lane,
    // An edge still open at the end runs off the bottom of the window.
    endRow: edge.endRow ?? commits.length,
    endLane: edge.endLane ?? edge.lane,
    firstParent: edge.firstParent,
    color: edge.color,
    open: edge.open || edge.endRow === null,
  }));

  return { rows, edges: resolved, laneCount: commits.length === 0 ? 0 : maxLane + 1 };
}
