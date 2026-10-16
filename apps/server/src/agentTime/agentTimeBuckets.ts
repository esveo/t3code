/**
 * Fork: bucket edges for agent time, days in the client's time zone or hours
 * of a rolling window.
 *
 * @module agentTimeBuckets
 */
import * as DateTime from "effect/DateTime";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone`'s wall clock is ahead of UTC at `instantMs`. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  let format = offsetFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormats.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instantMs)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallMs = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wallMs - Math.floor(instantMs / 1000) * 1000;
}

function isoDay(utcMidnightMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(utcMidnightMs)).slice(0, 10);
}

/** The instant a `YYYY-MM-DD` day starts in `timeZone`. */
export function zonedDayStartMs(day: string, timeZone: string): number {
  const wallMidnight = Date.parse(`${day}T00:00:00Z`);
  let instant = wallMidnight - zoneOffsetMs(wallMidnight, timeZone);
  // Once more, for a day whose offset differs from the UTC guess's (DST).
  instant = wallMidnight - zoneOffsetMs(instant, timeZone);
  return instant;
}

/** Days `sinceDay..untilDay` inclusive, as `YYYY-MM-DD`. */
export function enumerateWindowDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(isoDay(cursor));
  }
  return days;
}

/** Edges of `days` plus the end of the last one. */
export function dayEdges(days: ReadonlyArray<string>, timeZone: string): number[] {
  if (days.length === 0) return [];
  const edges = days.map((day) => zonedDayStartMs(day, timeZone));
  const last = days[days.length - 1]!;
  const next = isoDay(Date.parse(`${last}T00:00:00Z`) + DAY_MS);
  edges.push(zonedDayStartMs(next, timeZone));
  return edges;
}

/** An epoch instant as an ISO string. */
export function isoInstant(epochMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

/** Hour edges of a rolling `[sinceMs, untilMs)` window. */
export function hourEdges(sinceMs: number, untilMs: number): number[] {
  const edges: number[] = [];
  for (let cursor = sinceMs; cursor < untilMs; cursor += HOUR_MS) edges.push(cursor);
  edges.push(untilMs);
  return edges;
}
