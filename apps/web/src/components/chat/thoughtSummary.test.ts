import { describe, expect, it } from "vite-plus/test";
import { deriveThoughtTrail, deriveTurnsWithThoughts, readTurnThoughts } from "./thoughtSummary";

const entries = [
  { kind: "message", message: { role: "user", text: "fix the bug", turnId: "turn-1" } },
  {
    kind: "message",
    message: { role: "reasoning", text: "First I read the file.", turnId: "turn-1" },
  },
  { kind: "work" },
  { kind: "message", message: { role: "assistant", text: "Fixed it.", turnId: "turn-1" } },
  {
    kind: "message",
    message: { role: "reasoning", text: "Then I checked the test.", turnId: "turn-1" },
  },
  { kind: "message", message: { role: "reasoning", text: "   ", turnId: "turn-2" } },
  { kind: "message", message: { role: "reasoning", text: "Still going.", turnId: "turn-3" } },
];

describe("deriveTurnsWithThoughts", () => {
  it("names the turns that thought, and only those", () => {
    // turn-2 thought nothing but whitespace, turn-3 is still running.
    expect([...deriveTurnsWithThoughts(entries, "turn-3")]).toEqual(["turn-1"]);
  });

  it("includes a finished turn once it is no longer the live one", () => {
    expect([...deriveTurnsWithThoughts(entries, null)]).toEqual(["turn-1", "turn-3"]);
  });
});

describe("readTurnThoughts", () => {
  it("joins one turn's reasoning in order", () => {
    expect(readTurnThoughts(entries, "turn-1")).toBe(
      "First I read the file.\n\nThen I checked the test.",
    );
  });

  it("returns nothing for a turn that did not think", () => {
    expect(readTurnThoughts(entries, "turn-2")).toBe("");
  });
});

describe("deriveThoughtTrail", () => {
  it("takes the opening sentence of every paragraph, in order", () => {
    const trail = deriveThoughtTrail(
      "**Reading** the file. It has 900 lines.\n\nThe bug is in the resolver.\n\nPatched and tested.",
    );
    expect(trail.steps).toEqual([
      "Reading the file.",
      "The bug is in the resolver.",
      "Patched and tested.",
    ]);
  });

  it("keeps long sentences whole instead of clipping them", () => {
    const sentence = `${"a very deliberate thought ".repeat(20)}ends here.`;
    expect(deriveThoughtTrail(sentence).steps[0]).toBe(sentence);
  });

  it("keeps every beat of a long trace", () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `Step ${index}.`);
    const trail = deriveThoughtTrail(paragraphs.join("\n\n"));
    expect(trail.steps).toHaveLength(30);
    expect(trail.steps.at(-1)).toBe("Step 29.");
  });

  it("drops repeats and unreadable traces", () => {
    expect(deriveThoughtTrail("Let me check.\n\nLet me check.").steps).toEqual(["Let me check."]);
    expect(deriveThoughtTrail("\n\n   \n\n").steps).toEqual([]);
  });
});
