/** Fork: user insights. Timestamps are epoch milliseconds in code and ISO strings on disk. */
import * as DateTime from "effect/DateTime";

export const DAY_MS = 24 * 60 * 60 * 1000;

export const toIso = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** An unreadable timestamp counts as long ago. */
export const fromIso = (iso: string): number => {
  const parsed = DateTime.make(iso);
  return parsed._tag === "Some" ? DateTime.toEpochMillis(parsed.value) : 0;
};
