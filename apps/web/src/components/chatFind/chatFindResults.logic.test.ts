import { MessageId, PlanId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { buildChatFindPattern, collectChatFindMatches } from "../chat/ChatFind.logic";
import {
  buildChatFindResults,
  buildChatFindSnippet,
  chatFindResultWindow,
} from "./chatFindResults.logic";

const at = "2026-01-01T00:00:00.000Z";

function message(id: string, text: string, role: "user" | "assistant" | "system"): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: RunId.make("run-1"),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

function plan(id: string, planMarkdown: string): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: at,
    proposedPlan: {
      id: PlanId.make(id),
      runId: RunId.make("run-1"),
      planMarkdown,
      status: "active",
      createdAt: at,
      updatedAt: at,
    },
  };
}

describe("buildChatFindSnippet", () => {
  it("keeps short text whole", () => {
    expect(buildChatFindSnippet("fix the login bug", { start: 8, end: 13 })).toEqual({
      before: "fix the ",
      hit: "login",
      after: " bug",
    });
  });

  it("cuts long text at word boundaries and marks the cut", () => {
    const text = `${"lorem ipsum ".repeat(10)}login${" dolor sit".repeat(20)}`;
    const start = text.indexOf("login");
    const snippet = buildChatFindSnippet(text, { start, end: start + 5 });
    expect(snippet.hit).toBe("login");
    expect(snippet.before.startsWith("…")).toBe(true);
    expect(snippet.before.slice(1, 6)).toMatch(/^(lorem|ipsum)/);
    expect(snippet.after.endsWith("…")).toBe(true);
    expect(snippet.after.length).toBeLessThanOrEqual(92);
  });

  it("collapses line breaks into one line", () => {
    expect(buildChatFindSnippet("first\n\nlogin\nnext", { start: 7, end: 12 })).toEqual({
      before: "first ",
      hit: "login",
      after: " next",
    });
  });
});

describe("chatFindResultWindow", () => {
  it("renders everything when the list is short", () => {
    expect(chatFindResultWindow(10, 4, 150)).toEqual({ start: 0, end: 10 });
  });

  it("centers the window on the active match and clamps at both ends", () => {
    expect(chatFindResultWindow(1000, 500, 100)).toEqual({ start: 450, end: 550 });
    expect(chatFindResultWindow(1000, 3, 100)).toEqual({ start: 0, end: 100 });
    expect(chatFindResultWindow(1000, 990, 100)).toEqual({ start: 900, end: 1000 });
    expect(chatFindResultWindow(1000, -1, 100)).toEqual({ start: 0, end: 100 });
  });
});

describe("buildChatFindResults", () => {
  it("gives each match its own hit, source, and index", () => {
    const entries = [
      message("u1", "Please fix login and then login again", "user"),
      message("s1", "login system note", "system"),
      message("a1", "Fixed the **login** flow", "assistant"),
      plan("p1", "# Plan\n\n- check login"),
    ];
    const pattern = buildChatFindPattern("login")!;
    const matches = collectChatFindMatches(entries, pattern);
    const results = buildChatFindResults({
      entries,
      matches,
      pattern,
      cwd: undefined,
      start: 0,
      end: matches.length,
    });
    expect(results.map((result) => [result.index, result.source, result.snippet.after])).toEqual([
      [0, "user", " and then login again"],
      [1, "user", " again"],
      [2, "assistant", " flow"],
      [3, "plan", ""],
    ]);
  });

  it("builds only the requested window", () => {
    const entries = [message("u1", "a login b login c login", "user")];
    const pattern = buildChatFindPattern("login")!;
    const matches = collectChatFindMatches(entries, pattern);
    const results = buildChatFindResults({
      entries,
      matches,
      pattern,
      cwd: undefined,
      start: 1,
      end: 2,
    });
    expect(results.map((result) => result.index)).toEqual([1]);
  });
});
