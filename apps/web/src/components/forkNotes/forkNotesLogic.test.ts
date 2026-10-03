import type { ForkNote } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyForkNotesAction, parseForkNoteText, resolveForkNoteDrop } from "./forkNotesLogic";

const NOW = "2026-10-03T10:00:00.000Z";

const note = (
  id: string,
  options: { todo?: boolean; done?: boolean; scope?: ForkNote["scope"]; scopeId?: string } = {},
) =>
  ({
    id,
    scope: options.scope ?? "thread",
    scopeId: options.scopeId ?? "t1",
    text: id,
    todo: options.todo ?? false,
    done: options.done ?? false,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }) satisfies ForkNote;

// Open: a (todo), b (note); done: c, d.
const LIST = [
  note("a", { todo: true }),
  note("b"),
  note("c", { todo: true, done: true }),
  note("d", { todo: true, done: true }),
];

describe("resolveForkNoteDrop", () => {
  it("reorders among open rows and keeps them open", () => {
    expect(resolveForkNoteDrop(LIST, "a", { kind: "row", id: "b", after: true })).toEqual({
      position: 1,
      done: false,
    });
  });

  it("checks a todo off when it lands on the Done header or among done rows", () => {
    expect(resolveForkNoteDrop(LIST, "a", { kind: "done-head" })).toEqual({
      position: 1,
      done: true,
    });
    expect(resolveForkNoteDrop(LIST, "a", { kind: "row", id: "d", after: true })).toEqual({
      position: 3,
      done: true,
    });
  });

  it("reopens a done todo dragged up, and the open end only reorders", () => {
    expect(resolveForkNoteDrop(LIST, "d", { kind: "row", id: "a", after: false })).toEqual({
      position: 0,
      done: false,
    });
    expect(resolveForkNoteDrop(LIST, "c", { kind: "open-end" })).toEqual({
      position: 2,
      done: false,
    });
  });

  it("keeps notes out of the Done group", () => {
    expect(resolveForkNoteDrop(LIST, "b", { kind: "done-head" })).toBeNull();
    expect(resolveForkNoteDrop(LIST, "b", { kind: "row", id: "c", after: false })).toBeNull();
  });
});

describe("applyForkNotesAction", () => {
  it("moves an entry into another held list and renumbers both", () => {
    const lists = new Map([
      ["thread:t1", [note("a"), note("b")]],
      ["project:p1", [note("p", { scope: "project", scopeId: "p1" })]],
    ]);
    const next = applyForkNotesAction(
      lists,
      { type: "move", id: "a", scope: "project", scopeId: "p1", position: 1 },
      NOW,
    );
    expect(next.get("thread:t1")?.map((entry) => [entry.id, entry.position])).toEqual([["b", 0]]);
    expect(next.get("project:p1")?.map((entry) => [entry.id, entry.scope])).toEqual([
      ["p", "project"],
      ["a", "project"],
    ]);
  });

  it("drops the done state when a todo turns into a note", () => {
    const lists = new Map([["thread:t1", [note("a", { todo: true, done: true })]]]);
    const next = applyForkNotesAction(lists, { type: "update", id: "a", todo: false }, NOW);
    expect(next.get("thread:t1")?.[0]).toMatchObject({ todo: false, done: false });
  });
});

describe("parseForkNoteText", () => {
  it("finds inline code and bare links", () => {
    const parts = parseForkNoteText("Run `tsc` and see https://example.com/x.");
    expect(parts.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "tsc" },
      { kind: "text", text: " and see " },
      { kind: "link", text: "https://example.com/x" },
      { kind: "text", text: "." },
    ]);
    expect(parts.map((part) => part.start)).toEqual([0, 4, 9, 18, 39]);
  });
});
