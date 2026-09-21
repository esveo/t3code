/**
 * Editor-group style layout for chat panes, modelled on VS Code: a tree of
 * row/column splits whose leaves each show one thread. Exactly one leaf is the
 * routed pane (`thread: "route"`); it renders whatever the URL selects, so
 * normal navigation keeps working inside the grid.
 *
 * Everything here is pure so the drop, close, and resize rules can be tested
 * without rendering.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

export type SplitDirection = "row" | "column";
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

export interface SplitLeaf {
  readonly kind: "leaf";
  readonly id: string;
  readonly thread: "route" | ScopedThreadRef;
}

export interface SplitBranch {
  readonly kind: "split";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly children: readonly SplitNode[];
  /** Fractions of the branch, one per child, summing to 1. */
  readonly sizes: readonly number[];
}

export type SplitNode = SplitLeaf | SplitBranch;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const ROUTE_LEAF_ID = "route";
export const MIN_PANE_FRACTION = 0.1;

export const SINGLE_PANE_LAYOUT: SplitNode = { kind: "leaf", id: ROUTE_LEAF_ID, thread: "route" };

export function sameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function listLeaves(node: SplitNode): SplitLeaf[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(listLeaves);
}

export function findLeaf(node: SplitNode, leafId: string): SplitLeaf | null {
  return listLeaves(node).find((leaf) => leaf.id === leafId) ?? null;
}

/** The leaf showing `thread` outside the route pane, if any. */
export function findThreadLeaf(node: SplitNode, thread: ScopedThreadRef): SplitLeaf | null {
  return (
    listLeaves(node).find((leaf) => leaf.thread !== "route" && sameThread(leaf.thread, thread)) ??
    null
  );
}

function normalizeSizes(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : sizes.map(() => 1 / sizes.length);
}

/** Collapses single-child branches and merges a child branch into a parent with the same direction. */
function simplify(node: SplitNode): SplitNode {
  if (node.kind === "leaf") return node;
  const children: SplitNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const simplified = simplify(child);
    const size = node.sizes[index] ?? 0;
    if (simplified.kind === "split" && simplified.direction === node.direction) {
      simplified.children.forEach((grandchild, grandIndex) => {
        children.push(grandchild);
        sizes.push(size * (simplified.sizes[grandIndex] ?? 0));
      });
    } else {
      children.push(simplified);
      sizes.push(size);
    }
  });
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

/** Removes a leaf; the space it held goes to its neighbours. Removing the last leaf is a no-op. */
export function removeLeaf(root: SplitNode, leafId: string): SplitNode {
  if (root.kind === "leaf") return root;
  const remove = (node: SplitNode): SplitNode | null => {
    if (node.kind === "leaf") return node.id === leafId ? null : node;
    const children: SplitNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
      const next = remove(child);
      if (next) {
        children.push(next);
        sizes.push(node.sizes[index] ?? 0);
      }
    });
    if (children.length === 0) return null;
    return { ...node, children, sizes: normalizeSizes(sizes) };
  };
  return simplify(remove(root) ?? root);
}

function replaceNode(root: SplitNode, targetId: string, replace: (node: SplitNode) => SplitNode) {
  const visit = (node: SplitNode): SplitNode => {
    if (node.id === targetId) return replace(node);
    if (node.kind === "leaf") return node;
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/**
 * Places `leaf` next to the leaf `targetId` on the given edge, halving the
 * target's space. An existing leaf with the same id is moved rather than
 * duplicated.
 */
export function insertBeside(
  root: SplitNode,
  targetId: string,
  zone: Exclude<DropZone, "center">,
  leaf: SplitLeaf,
  newBranchId: string,
): SplitNode {
  if (targetId === leaf.id) return root;
  const withoutLeaf = findLeaf(root, leaf.id) ? removeLeaf(root, leaf.id) : root;
  if (!findLeaf(withoutLeaf, targetId)) return root;
  const direction: SplitDirection = zone === "left" || zone === "right" ? "row" : "column";
  const before = zone === "left" || zone === "top";
  return simplify(
    replaceNode(withoutLeaf, targetId, (target) => ({
      kind: "split",
      id: newBranchId,
      direction,
      children: before ? [leaf, target] : [target, leaf],
      sizes: [0.5, 0.5],
    })),
  );
}

/** Shows `thread` in the leaf `targetId` instead of what it showed before. */
export function setLeafThread(
  root: SplitNode,
  targetId: string,
  thread: SplitLeaf["thread"],
): SplitNode {
  return replaceNode(root, targetId, (node) => (node.kind === "leaf" ? { ...node, thread } : node));
}

/** Adds `leaf` as a new column on the right, shrinking the existing ones evenly. */
function appendColumn(root: SplitNode, leaf: SplitLeaf, makeId: (prefix: string) => string) {
  if (root.kind === "split" && root.direction === "row") {
    const share = 1 / (root.children.length + 1);
    return {
      ...root,
      children: [...root.children, leaf],
      sizes: [...root.sizes.map((size) => size * (1 - share)), share],
    };
  }
  return {
    kind: "split",
    id: makeId("split"),
    direction: "row",
    children: [root, leaf],
    sizes: [0.5, 0.5],
  } satisfies SplitBranch;
}

/**
 * Keeps the routed thread on screen and hands the route pane to whatever the
 * URL points at next: the thread moves into a pane of its own and a fresh
 * route pane is appended. Used when a new thread starts while the split is
 * open, so it joins the grid instead of taking over the pane the user was
 * reading. Without a split, or when the thread already has a pane of its own,
 * the layout is unchanged.
 */
export function appendRoutePane(
  root: SplitNode,
  routeThread: ScopedThreadRef,
  makeId: (prefix: string) => string,
): SplitNode {
  if (root.kind === "leaf") return root;
  if (!findLeaf(root, ROUTE_LEAF_ID) || findThreadLeaf(root, routeThread)) return root;
  const pinned = replaceNode(root, ROUTE_LEAF_ID, () => ({
    kind: "leaf",
    id: makeId("pane"),
    thread: routeThread,
  }));
  return appendColumn(pinned, { kind: "leaf", id: ROUTE_LEAF_ID, thread: "route" }, makeId);
}

/**
 * Appends a pane showing `thread` without touching the route pane, for opening
 * a thread from outside the grid. Returns null when there is no split to append
 * to, or when the thread already has a pane.
 */
export function appendThreadPane(
  root: SplitNode,
  thread: ScopedThreadRef,
  makeId: (prefix: string) => string,
): { readonly layout: SplitNode; readonly leafId: string } | null {
  if (root.kind === "leaf" || findThreadLeaf(root, thread)) return null;
  const leaf: SplitLeaf = { kind: "leaf", id: makeId("pane"), thread };
  return { layout: appendColumn(root, leaf, makeId), leafId: leaf.id };
}

/** Swaps the positions of two leaves, keeping their ids and threads together. */
export function swapLeaves(root: SplitNode, firstId: string, secondId: string): SplitNode {
  const first = findLeaf(root, firstId);
  const second = findLeaf(root, secondId);
  if (!first || !second || firstId === secondId) return root;
  const visit = (node: SplitNode): SplitNode => {
    if (node.kind === "leaf") {
      if (node.id === firstId) return second;
      if (node.id === secondId) return first;
      return node;
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/** Moves the divider after child `index` of `branchId` to `fraction` of that branch. */
/**
 * Moves divider `index` of `branchId` to `fraction` of the branch. Once the
 * pane ahead of it reaches its minimum, the divider pushes the next ones
 * along, as far as the minimums of all panes on that side allow.
 */
export function resizeBranch(
  root: SplitNode,
  branchId: string,
  index: number,
  fraction: number,
): SplitNode {
  return replaceNode(root, branchId, (node) => {
    const count = node.kind === "split" ? node.children.length : 0;
    if (node.kind !== "split" || index < 0 || index >= count - 1) return node;
    const lowest = (index + 1) * MIN_PANE_FRACTION;
    const highest = 1 - (count - index - 1) * MIN_PANE_FRACTION;
    if (lowest > highest) return node;
    const sizes = [...node.sizes];
    const position = sizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0);
    const target = Math.min(highest, Math.max(lowest, fraction));
    const step = target > position ? 1 : -1;
    let remaining = Math.abs(target - position);
    for (let i = step > 0 ? index + 1 : index; remaining > 0 && i >= 0 && i < count; i += step) {
      const taken = Math.min(remaining, Math.max(0, (sizes[i] ?? 0) - MIN_PANE_FRACTION));
      sizes[i] = (sizes[i] ?? 0) - taken;
      remaining -= taken;
    }
    const grown = step > 0 ? index : index + 1;
    sizes[grown] = (sizes[grown] ?? 0) + Math.abs(target - position) - remaining;
    return { ...node, sizes };
  });
}

/** Gives every child of `branchId` the same share, like VS Code's divider double-click. */
export function equalizeBranch(root: SplitNode, branchId: string): SplitNode {
  return replaceNode(root, branchId, (node) =>
    node.kind === "split"
      ? { ...node, sizes: node.children.map(() => 1 / node.children.length) }
      : node,
  );
}

export interface LayoutPane {
  readonly leaf: SplitLeaf;
  readonly rect: Rect;
}

export interface LayoutDivider {
  readonly branchId: string;
  readonly index: number;
  readonly direction: SplitDirection;
  /** Where the divider sits, in fractions of the whole grid. */
  readonly rect: Rect;
  /** The branch the divider resizes, in fractions of the whole grid. */
  readonly branchRect: Rect;
}

/** Lays the tree out in unit coordinates (0..1 on both axes). */
export function computeLayout(root: SplitNode): {
  panes: LayoutPane[];
  dividers: LayoutDivider[];
} {
  const panes: LayoutPane[] = [];
  const dividers: LayoutDivider[] = [];
  const visit = (node: SplitNode, rect: Rect) => {
    if (node.kind === "leaf") {
      panes.push({ leaf: node, rect });
      return;
    }
    let offset = 0;
    node.children.forEach((child, index) => {
      const size = node.sizes[index] ?? 0;
      const childRect: Rect =
        node.direction === "row"
          ? {
              left: rect.left + offset * rect.width,
              top: rect.top,
              width: size * rect.width,
              height: rect.height,
            }
          : {
              left: rect.left,
              top: rect.top + offset * rect.height,
              width: rect.width,
              height: size * rect.height,
            };
      visit(child, childRect);
      offset += size;
      if (index < node.children.length - 1) {
        dividers.push({
          branchId: node.id,
          index,
          direction: node.direction,
          branchRect: rect,
          rect:
            node.direction === "row"
              ? {
                  left: rect.left + offset * rect.width,
                  top: rect.top,
                  width: 0,
                  height: rect.height,
                }
              : {
                  left: rect.left,
                  top: rect.top + offset * rect.height,
                  width: rect.width,
                  height: 0,
                },
        });
      }
    });
  };
  visit(root, { left: 0, top: 0, width: 1, height: 1 });
  return { panes, dividers };
}

/**
 * Which part of a pane a pointer at (x, y) — relative to the pane, 0..1 —
 * targets. The outer third of each edge splits, the middle replaces.
 */
export function resolveDropZone(x: number, y: number): DropZone {
  const edge = 1 / 3;
  const distances: Array<[Exclude<DropZone, "center">, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [zone, distance] = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return distance < edge ? zone : "center";
}

/** The part of a pane highlighted for a drop zone, relative to the pane. */
export function dropZoneRect(zone: DropZone): Rect {
  switch (zone) {
    case "left":
      return { left: 0, top: 0, width: 0.5, height: 1 };
    case "right":
      return { left: 0.5, top: 0, width: 0.5, height: 1 };
    case "top":
      return { left: 0, top: 0, width: 1, height: 0.5 };
    case "bottom":
      return { left: 0, top: 0.5, width: 1, height: 0.5 };
    case "center":
      return { left: 0, top: 0, width: 1, height: 1 };
  }
}

/** Drops a thread that is not yet shown beside the route pane. */
export function dropNewThread(
  root: SplitNode,
  input: {
    readonly targetLeafId: string;
    readonly zone: DropZone;
    readonly thread: ScopedThreadRef;
    readonly newLeafId: string;
    readonly newBranchId: string;
  },
): SplitNode {
  if (input.zone === "center") {
    return input.targetLeafId === ROUTE_LEAF_ID
      ? root
      : setLeafThread(root, input.targetLeafId, input.thread);
  }
  return insertBeside(
    root,
    input.targetLeafId,
    input.zone,
    { kind: "leaf", id: input.newLeafId, thread: input.thread },
    input.newBranchId,
  );
}

/** Drops an existing pane: edges move it, the centre swaps the two panes. */
export function dropExistingLeaf(
  root: SplitNode,
  input: {
    readonly sourceLeafId: string;
    readonly targetLeafId: string;
    readonly zone: DropZone;
    readonly newBranchId: string;
  },
): SplitNode {
  if (input.sourceLeafId === input.targetLeafId) return root;
  const source = findLeaf(root, input.sourceLeafId);
  if (!source) return root;
  if (input.zone === "center") return swapLeaves(root, input.sourceLeafId, input.targetLeafId);
  return insertBeside(root, input.targetLeafId, input.zone, source, input.newBranchId);
}

/** Drops invalid leaves (for example threads that no longer exist) and repairs a missing route pane. */
export function sanitizeLayout(root: SplitNode | null | undefined): SplitNode {
  if (!root || typeof root !== "object") return SINGLE_PANE_LAYOUT;
  const leaves = listLeaves(root);
  const routeLeaves = leaves.filter((leaf) => leaf.thread === "route");
  if (routeLeaves.length !== 1 || routeLeaves[0]!.id !== ROUTE_LEAF_ID) return SINGLE_PANE_LAYOUT;
  const ids = new Set(leaves.map((leaf) => leaf.id));
  return ids.size === leaves.length ? simplify(root) : SINGLE_PANE_LAYOUT;
}

/** The leaf closest to `leafId` in tree order, preferring its own branch. */
function nearestOtherLeaf(root: SplitNode, leafId: string): SplitLeaf | null {
  const leaves = listLeaves(root);
  const index = leaves.findIndex((leaf) => leaf.id === leafId);
  if (index === -1) return null;
  return leaves[index + 1] ?? leaves[index - 1] ?? null;
}

/**
 * Closes a pane. Closing the route pane promotes its nearest neighbour: that
 * pane becomes the route pane and the caller navigates to its thread.
 */
export function closeLeaf(
  root: SplitNode,
  leafId: string,
): { readonly layout: SplitNode; readonly navigateTo: ScopedThreadRef | null } {
  if (leafId !== ROUTE_LEAF_ID) return { layout: removeLeaf(root, leafId), navigateTo: null };
  const neighbour = nearestOtherLeaf(root, leafId);
  if (!neighbour || neighbour.thread === "route") return { layout: root, navigateTo: null };
  const promoted = replaceNode(removeLeaf(root, ROUTE_LEAF_ID), neighbour.id, () => ({
    kind: "leaf",
    id: ROUTE_LEAF_ID,
    thread: "route",
  }));
  return { layout: promoted, navigateTo: neighbour.thread };
}

export interface GridSize {
  readonly columns: number;
  readonly rows: number;
}

export const AUTO_ARRANGE_MIN_PANE = { width: 420, height: 280 } as const;

/**
 * How many panes each column of a `columns × rows` grid holds for `count`
 * threads: spread as evenly as possible, never more than `rows` per column,
 * with the shorter columns first so the leading threads get the taller panes.
 * Threads beyond the grid's capacity are left out.
 */
export function gridColumnCounts(count: number, grid: GridSize): number[] {
  const placed = Math.min(count, grid.columns * grid.rows);
  if (placed <= 0) return [];
  const columns = Math.min(grid.columns, placed);
  const base = Math.floor(placed / columns);
  const remainder = placed % columns;
  return Array.from({ length: columns }, (_, index) =>
    index < columns - remainder ? base : base + 1,
  );
}

/**
 * The grid Auto Arrange suggests for `count` threads in an area of
 * `width × height` pixels: every pane must keep a usable minimum size; among
 * the grids that allow that, the one whose smallest pane is largest wins, and
 * ties go to more columns because chats read better tall than wide. When no
 * grid fits every thread, the largest grid that keeps the minimum is used.
 */
export function recommendGrid(
  count: number,
  width: number,
  height: number,
  minimum: { readonly width: number; readonly height: number } = AUTO_ARRANGE_MIN_PANE,
): GridSize {
  if (count <= 0) return { columns: 1, rows: 1 };
  let best: { grid: GridSize; area: number } | null = null;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const paneWidth = width / columns;
    const paneHeight = height / rows;
    if (paneWidth < minimum.width || paneHeight < minimum.height) continue;
    const area = paneWidth * paneHeight;
    if (!best || area >= best.area - 1e-6) best = { grid: { columns, rows }, area };
  }
  if (best) return best.grid;
  return {
    columns: Math.max(1, Math.floor(width / minimum.width)),
    rows: Math.max(1, Math.floor(height / minimum.height)),
  };
}

/**
 * Builds the layout for Auto Arrange: columns of equal width, each split into
 * equal panes. The routed thread keeps the route pane; when it is not among
 * the arranged threads, the first thread takes the route pane and the caller
 * navigates to it.
 */
export function buildGridLayout(input: {
  readonly threads: readonly ScopedThreadRef[];
  readonly routeThread: ScopedThreadRef | null;
  readonly grid: GridSize;
  readonly makeId: (prefix: string) => string;
}): { readonly layout: SplitNode; readonly navigateTo: ScopedThreadRef | null } {
  const counts = gridColumnCounts(input.threads.length, input.grid);
  const placed = input.threads.slice(
    0,
    counts.reduce((sum, value) => sum + value, 0),
  );
  if (placed.length === 0) return { layout: SINGLE_PANE_LAYOUT, navigateTo: null };
  const routeIndex = input.routeThread
    ? placed.findIndex((thread) => sameThread(thread, input.routeThread!))
    : -1;
  const routeSlot = routeIndex === -1 ? 0 : routeIndex;
  const leaves: SplitLeaf[] = placed.map((thread, index) =>
    index === routeSlot
      ? { kind: "leaf", id: ROUTE_LEAF_ID, thread: "route" }
      : { kind: "leaf", id: input.makeId("pane"), thread },
  );
  let offset = 0;
  const columns: SplitNode[] = counts.map((columnCount) => {
    const panes = leaves.slice(offset, offset + columnCount);
    offset += columnCount;
    return panes.length === 1
      ? panes[0]!
      : {
          kind: "split",
          id: input.makeId("split"),
          direction: "column",
          children: panes,
          sizes: panes.map(() => 1 / panes.length),
        };
  });
  const layout: SplitNode =
    columns.length === 1
      ? columns[0]!
      : {
          kind: "split",
          id: input.makeId("split"),
          direction: "row",
          children: columns,
          sizes: columns.map(() => 1 / columns.length),
        };
  return { layout, navigateTo: routeIndex === -1 ? placed[0]! : null };
}
