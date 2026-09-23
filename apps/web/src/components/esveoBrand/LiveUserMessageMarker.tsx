/**
 * Fork: marks the user message whose turn is running, for esveo Midnight's
 * rotating ring. The timeline is virtualized and recycles its row containers,
 * so CSS alone cannot tell which bubble is the latest; this sets
 * `--live-user-message: 1` on that row (and on the pinned pill standing in for
 * it), which esveoMidnight.css picks up with a style container query. Renders
 * nothing once the turn settles.
 */
export function LiveUserMessageMarker({ rowId }: { rowId: string | null }) {
  if (rowId === null) return null;
  const id = CSS.escape(rowId);
  return (
    <style>{`[data-timeline-row-id="${id}"],[data-pinned-user-message-row-id="${id}"]{--live-user-message:1}`}</style>
  );
}
