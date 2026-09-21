import { describe, expect, it } from "vite-plus/test";
import {
  deriveStubThoughtTrail,
  deriveTurnsWithThoughts,
  readTurnThoughts,
} from "./thoughtSummary";

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
  it("joins the turn's reasoning in order", () => {
    expect(readTurnThoughts(entries, "turn-1")).toBe(
      "First I read the file.\n\nThen I checked the test.",
    );
  });

  it("returns nothing for a turn that did not think", () => {
    expect(readTurnThoughts(entries, "turn-2")).toBe("");
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
