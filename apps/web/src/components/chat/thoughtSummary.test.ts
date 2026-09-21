import { describe, expect, it } from "vite-plus/test";
import { deriveStubThoughtTrail, resolveThoughtTrailSource } from "./thoughtSummary";

const messages = [
  { role: "user", text: "fix the bug", turnId: "turn-1" },
  { role: "reasoning", text: "First I read the file.", turnId: "turn-1" },
  { role: "assistant", text: "Fixed it.", turnId: "turn-1" },
  { role: "reasoning", text: "Then I checked the test.", turnId: "turn-1" },
  { role: "reasoning", text: "A later turn.", turnId: "turn-2" },
];

describe("resolveThoughtTrailSource", () => {
  it("joins the turn's reasoning and keys it per thread turn", () => {
    expect(
      resolveThoughtTrailSource({ messages, turnId: "turn-1", settled: true, keyPrefix: "t" }),
    ).toEqual({ key: "t:turn-1", text: "First I read the file.\n\nThen I checked the test." });
  });

  it("offers nothing until the turn has settled", () => {
    expect(
      resolveThoughtTrailSource({ messages, turnId: "turn-1", settled: false, keyPrefix: "t" }),
    ).toBeNull();
  });

  it("offers nothing for a turn that did not think", () => {
    expect(
      resolveThoughtTrailSource({
        messages: [{ role: "reasoning", text: "   ", turnId: "turn-1" }],
        turnId: "turn-1",
        settled: true,
        keyPrefix: "t",
      }),
    ).toBeNull();
    expect(
      resolveThoughtTrailSource({ messages, turnId: null, settled: true, keyPrefix: "t" }),
    ).toBeNull();
  });
});

describe("deriveStubThoughtTrail", () => {
  it("takes one beat per paragraph and ends on the last", () => {
    const trail = deriveStubThoughtTrail(
      "**Reading** the file. It has 900 lines.\n\nThe bug is in the resolver.\n\nPatched and tested.",
    );
    expect(trail.steps).toEqual(["Reading the file.", "The bug is in the resolver."]);
    expect(trail.outcome).toBe("Patched and tested.");
  });

  it("spans a long trace instead of taking only the opening", () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `Step ${index}.`);
    const trail = deriveStubThoughtTrail(paragraphs.join("\n\n"));
    expect(trail.steps.length + 1).toBeLessThanOrEqual(7);
    expect(trail.steps[0]).toBe("Step 0.");
    expect(trail.outcome).toBe("Step 29.");
  });

  it("survives a trace with nothing readable in it", () => {
    expect(deriveStubThoughtTrail("\n\n   \n\n")).toEqual({ steps: [], outcome: null });
  });
});
