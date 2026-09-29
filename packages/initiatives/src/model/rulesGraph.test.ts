import type { InitiativeEntry, InitiativeEntryLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { initiativeStartPrompt } from "./index.ts";
import { closesDependencyLoop, rulesForPrompt, taskGraph } from "./rulesGraph.ts";

const entry = (id: string, overrides: Partial<InitiativeEntry>): InitiativeEntry =>
  ({
    id,
    revision: 1,
    createdAt: `2026-09-29T10:00:0${id.length}.000Z`,
    updatedAt: "2026-09-29T10:00:00.000Z",
    createdBy: "person:robert",
    updatedBy: "person:robert",
    initiativeId: "i1",
    type: "task",
    title: id,
    bodyMd: "",
    status: "open",
    details: {},
    origin: { threadId: null, messageId: null },
    supersedes: null,
    inbox: null,
    urgency: null,
    dependsOn: [],
    routeToThreadId: null,
    snoozedAt: null,
    legacyKey: null,
    ...overrides,
  }) as InitiativeEntry;

const dependsOn = (fromId: string, toId: string) =>
  ({ fromId, toId, kind: "dependsOn" }) as InitiativeEntryLink;

describe("rules", () => {
  it("numbers only the active rules, oldest first, in the start prompt", () => {
    const rules = rulesForPrompt([
      entry("bb", { type: "rule", status: "active", title: "Zweite" }),
      entry("a", { type: "rule", status: "active", title: "Erste" }),
      entry("ccc", { type: "rule", status: "proposed", title: "Vorschlag" }),
      entry("dddd", { type: "rule", status: "revoked", title: "Aufgehoben" }),
    ]);
    expect(rules).toEqual(["Erste", "Zweite"]);
    const prompt = initiativeStartPrompt({
      initiative: { id: "i1", title: "T", goalText: "", instructionsMd: "" },
      role: "participant",
      prompt: "Los.",
      brain: { rules },
    });
    expect(prompt).toContain("1. Erste\n2. Zweite");
  });
});

describe("taskGraph", () => {
  it("makes a task ready once every task it reads from is done", () => {
    const entries = [
      entry("a", { status: "done" }),
      entry("b", {}),
      entry("c", { details: { passes: { a: "URLs", b: "Bewertung" } } }),
      entry("d", { status: "running" }),
    ];
    const graph = taskGraph(entries, [dependsOn("c", "a"), dependsOn("c", "b")]);
    expect(graph.get("b")?.ready).toBe(true);
    expect(graph.get("c")?.ready).toBe(false);
    expect(graph.get("c")?.dependsOn.map((d) => [d.entryId, d.done, d.passes])).toEqual([
      ["a", true, "URLs"],
      ["b", false, "Bewertung"],
    ]);
    // Already started: not offered again.
    expect(graph.get("d")?.ready).toBe(false);
  });

  it("does not count a cancelled or missing dependency as delivered", () => {
    const graph = taskGraph(
      [entry("a", { status: "cancelled" }), entry("b", {})],
      [dependsOn("b", "a"), dependsOn("b", "gone")],
    );
    expect(graph.get("b")?.ready).toBe(false);
  });

  it("refuses a dependency that closes a loop", () => {
    const links = [dependsOn("b", "a"), dependsOn("c", "b")];
    expect(closesDependencyLoop(links, "a", "c")).toBe(true);
    expect(closesDependencyLoop(links, "c", "a")).toBe(false);
  });
});
