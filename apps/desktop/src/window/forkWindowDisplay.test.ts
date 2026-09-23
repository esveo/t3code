import { assert, describe, it } from "@effect/vitest";

import { keepNormalBoundsOnWindowDisplay } from "./forkWindowDisplay.ts";

const primary = { x: 0, y: 0, width: 1512, height: 982 };
const external = { x: 1512, y: -300, width: 2560, height: 1440 };

describe("keepNormalBoundsOnWindowDisplay", () => {
  it("keeps normal bounds that are on the window's display", () => {
    const normal = { x: 1700, y: -200, width: 1200, height: 800 };
    assert.deepEqual(
      keepNormalBoundsOnWindowDisplay(normal, external, [primary, external]),
      normal,
    );
  });

  it("moves stale normal bounds onto the display a maximized window fills", () => {
    const stale = { x: 206, y: 37, width: 1100, height: 780 };
    assert.deepEqual(keepNormalBoundsOnWindowDisplay(stale, external, [primary, external]), {
      x: 1512 + 730,
      y: -300 + 330,
      width: 1100,
      height: 780,
    });
  });

  it("shrinks normal bounds that are larger than the target display", () => {
    const normal = { x: 1600, y: -250, width: 2400, height: 1300 };
    assert.deepEqual(keepNormalBoundsOnWindowDisplay(normal, primary, [primary, external]), {
      x: 0,
      y: 0,
      width: 1512,
      height: 982,
    });
  });

  it("keeps normal bounds when the window is on no known display", () => {
    const normal = { x: 206, y: 37, width: 1100, height: 780 };
    const offscreen = { x: 9000, y: 9000, width: 800, height: 600 };
    assert.deepEqual(keepNormalBoundsOnWindowDisplay(normal, offscreen, [primary]), normal);
  });
});
