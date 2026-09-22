import type { CommitGraphEdge } from "./commitGraphLayout";

/** Geometry of one commit row and one lane, shared by the edges and the dots. */
export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 14;
export const LANE_PADDING = 10;

export const laneX = (lane: number) => LANE_PADDING + lane * LANE_WIDTH;
export const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

/**
 * Child lane -> carrier lane -> parent lane, bending once at each change. A
 * merge parent bends late (just above its parent) and a branch tip bends early,
 * which is what makes a merge read as joining rather than crossing.
 */
export function edgePath(edge: CommitGraphEdge): string {
  const startX = laneX(edge.startLane);
  const startY = rowY(edge.startRow);
  const endX = laneX(edge.endLane);
  const endY = edge.open ? edge.endRow * ROW_HEIGHT : rowY(edge.endRow);
  // An edge between neighbouring rows crosses no row, so it needs no lane of
  // its own to travel in. Routing it through the lane the layout reserved would
  // bend it out and straight back again within one row, which reads as a loop.
  const carrierX = edge.endRow - edge.startRow <= 1 ? endX : laneX(edge.lane);

  let path = `M${startX} ${startY}`;
  if (carrierX !== startX) {
    path +=
      ` L${startX} ${startY + ROW_HEIGHT * 0.3}` +
      ` C${startX} ${startY + ROW_HEIGHT * 0.75} ${carrierX} ${startY + ROW_HEIGHT * 0.5}` +
      ` ${carrierX} ${startY + ROW_HEIGHT}`;
  }
  const straightUntil = endX === carrierX ? endY : endY - ROW_HEIGHT;
  path += ` L${carrierX} ${Math.max(straightUntil, startY)}`;
  if (endX !== carrierX) {
    path += ` C${carrierX} ${endY - ROW_HEIGHT * 0.45} ${endX} ${endY - ROW_HEIGHT * 0.7} ${endX} ${endY}`;
  }
  return path;
}
