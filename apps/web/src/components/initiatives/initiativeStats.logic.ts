/** Fork: how the initiatives' statistics read: dollars, tokens, run time and ranges. */

export const formatUsd = (value: number) =>
  value < 10 ? `${value.toFixed(2).replace(".", ",")} $` : `${Math.round(value)} $`;

export const formatTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(".", ",")} Mio.`
    : value >= 1_000
      ? `${Math.round(value / 1_000)} Tsd.`
      : String(Math.round(value));

export const formatDuration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
};

/** A middle range as "a–b", one value when both ends read the same. */
export const formatRange = (
  range: readonly [number, number] | null,
  format: (value: number) => string,
) => {
  if (!range) return null;
  const [low, high] = [format(range[0]), format(range[1])];
  if (low === high) return low;
  const unit = / \S+$/.exec(high)?.[0];
  return unit && low.endsWith(unit) ? `${low.slice(0, -unit.length)}–${high}` : `${low}–${high}`;
};
