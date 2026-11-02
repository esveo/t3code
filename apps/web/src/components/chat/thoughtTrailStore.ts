import { useEffect, useSyncExternalStore } from "react";

import { deriveTurnsWithThoughts, readTurnThoughts, type ThoughtEntry } from "./thoughtSummary";

interface TimelineThoughts {
  readonly entries: ReadonlyArray<ThoughtEntry>;
  readonly turns: ReadonlySet<string>;
}

const EMPTY_TURNS: ReadonlySet<string> = new Set();
/**
 * Keyed by timeline, because split view runs several at once and each footer
 * must read its own thread's thinking.
 */
const byTimeline = new Map<string, TimelineThoughts>();
const listeners = new Set<() => void>();

/** Module store avoids wrapping the upstream timeline; only membership changes notify. */
function publishTimelineThoughts(
  timelineKey: string,
  entries: ReadonlyArray<ThoughtEntry>,
  liveRunId: string | null,
) {
  const turns = deriveTurnsWithThoughts(entries, liveRunId);
  const previous = byTimeline.get(timelineKey);
  byTimeline.set(timelineKey, { entries, turns });
  if (previous === undefined || !sameMembers(previous.turns, turns)) {
    for (const listener of listeners) listener();
  }
}

function forgetTimelineThoughts(timelineKey: string) {
  if (byTimeline.delete(timelineKey)) {
    for (const listener of listeners) listener();
  }
}

/** Read at click time, so a megabyte of trace never sits in React state. */
export function readTimelineThoughts(timelineKey: string, runId: string): string {
  const source = byTimeline.get(timelineKey);
  return source === undefined ? "" : readTurnThoughts(source.entries, runId);
}

export function useTimelineThoughtTurns(timelineKey: string | null): ReadonlySet<string> {
  const read = () =>
    timelineKey === null ? EMPTY_TURNS : (byTimeline.get(timelineKey)?.turns ?? EMPTY_TURNS);
  // Same snapshot server-side: the store is plain module state, and rendering
  // to markup must not diverge from the first client frame.
  return useSyncExternalStore(subscribe, read, read);
}

/** Publishes after paint: the footers read it on the next frame, never mid-render. */
export function usePublishTimelineThoughts(
  timelineKey: string,
  entries: ReadonlyArray<ThoughtEntry>,
  liveRunId: string | null,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes timeline state to the external module store
  useEffect(() => {
    publishTimelineThoughts(timelineKey, entries, liveRunId);
  }, [entries, liveRunId, timelineKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unregisters the external timeline entry on unmount
  useEffect(() => () => forgetTimelineThoughts(timelineKey), [timelineKey]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const member of left) {
    if (!right.has(member)) return false;
  }
  return true;
}
