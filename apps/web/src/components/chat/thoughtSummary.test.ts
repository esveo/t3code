import { describe, expect, it } from "vite-plus/test";
import { deriveTurnsWithThoughts } from "./thoughtSummary";

const entries = [
  { kind: "message", message: { role: "user", text: "fix the bug", turnId: "turn-1" } },
  {
    kind: "message",
    message: { role: "reasoning", text: "First I read the file.", turnId: "turn-1" },
  },
  { kind: "work" },
  { kind: "message", message: { role: "assistant", text: "Fixed it.", turnId: "turn-1" } },
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

  it("offers nothing for a thread without reasoning", () => {
    expect(deriveTurnsWithThoughts([{ kind: "work" }], null).size).toBe(0);
  });
});
