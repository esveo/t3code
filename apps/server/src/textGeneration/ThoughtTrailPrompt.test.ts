import { describe, expect, it } from "vite-plus/test";

import {
  buildThoughtTrailPrompt,
  limitThoughtTrace,
  sanitizeThoughtTrail,
} from "./ThoughtTrailPrompt.ts";

describe("limitThoughtTrace", () => {
  it("leaves a trace that fits alone", () => {
    expect(limitThoughtTrace("  short trace  ")).toBe("short trace");
  });

  it("keeps both ends of a long trace", () => {
    const trace = `START${"x".repeat(40_000)}END`;
    const limited = limitThoughtTrace(trace);

    expect(limited.startsWith("START")).toBe(true);
    expect(limited.endsWith("END")).toBe(true);
    expect(limited).toContain("[Middle of the trace omitted]");
    expect(limited.length).toBeLessThan(trace.length);
  });
});

describe("buildThoughtTrailPrompt", () => {
  it("carries the trace and states the JSON shape for providers without schemas", () => {
    const { prompt, outputSchema } = buildThoughtTrailPrompt({ trace: "Checked the resolver." });

    expect(prompt).toContain("Checked the resolver.");
    expect(prompt).toContain("steps (array of strings), outcome (string)");
    expect(Object.keys(outputSchema.fields)).toEqual(["steps", "outcome"]);
  });
});

describe("sanitizeThoughtTrail", () => {
  it("strips list markup, collapses whitespace and drops repeats", () => {
    expect(
      sanitizeThoughtTrail({
        steps: ["- Read  the\nfile", "1. Read the file", "* **Patched** it", "   "],
        outcome: "Tests pass.",
      }),
    ).toEqual({ steps: ["Read the file", "Patched it"], outcome: "Tests pass." });
  });

  it("caps the trail so the popup stays skimmable", () => {
    const steps = Array.from({ length: 12 }, (_, index) => `Beat ${index}`);
    expect(sanitizeThoughtTrail({ steps, outcome: "" }).steps).toEqual([
      "Beat 0",
      "Beat 1",
      "Beat 2",
      "Beat 3",
      "Beat 4",
      "Beat 5",
    ]);
  });

  it("reports an empty outcome as none", () => {
    expect(sanitizeThoughtTrail({ steps: [], outcome: "  " }).outcome).toBeNull();
  });

  it("truncates a beat that runs long", () => {
    const { steps } = sanitizeThoughtTrail({ steps: ["word ".repeat(100)], outcome: "done" });
    expect(steps[0]?.length).toBeLessThanOrEqual(200);
    expect(steps[0]?.endsWith("…")).toBe(true);
  });
});
