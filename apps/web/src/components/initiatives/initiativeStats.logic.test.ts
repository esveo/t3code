import { describe, expect, it } from "vite-plus/test";

import { formatDuration, formatRange, formatTokens, formatUsd } from "./initiativeStats.logic";

describe("initiative statistics formatting", () => {
  it("reads a range with its unit once", () => {
    expect(formatRange([0.8, 2.1], formatUsd)).toBe("0,80–2,10 $");
    expect(formatRange([1_200, 45_000], formatTokens)).toBe("1–45 Tsd.");
    expect(formatRange([1.5, 1.5], formatUsd)).toBe("1,50 $");
    expect(formatRange(null, formatUsd)).toBeNull();
  });

  it("keeps different units on both ends", () => {
    expect(formatRange([900, 2_000_000], formatTokens)).toBe("900–2,0 Mio.");
    expect(formatRange([5_000, 2_000_000], formatTokens)).toBe("5 Tsd.–2,0 Mio.");
    expect(formatDuration(95 * 60_000)).toBe("1 h 35 min");
  });
});
