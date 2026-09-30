import { describe, expect, it } from "vite-plus/test";

import { findEasterEgg } from "./easterEggs";

describe("findEasterEgg", () => {
  it("finds the rocket for a message that is only esveo", () => {
    expect(findEasterEgg("esveo")?.message).toBe("esveo");
    expect(findEasterEgg("  ESVEO \n")?.message).toBe("esveo");
  });

  it("ignores messages that merely mention esveo", () => {
    expect(findEasterEgg("esveo rocks")).toBeNull();
    expect(findEasterEgg("ask esveo")).toBeNull();
    expect(findEasterEgg("")).toBeNull();
  });
});
