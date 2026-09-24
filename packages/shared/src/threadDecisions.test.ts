import { ThreadDecision, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyReply,
  decisionKind,
  formatDecisionReplies,
  reopenDecision,
  resolveDecision,
  shortenContext,
  upsertDecision,
  validateDecisionInput,
  validateReply,
  type ThreadDecisionInput,
} from "./threadDecisions.ts";

const decodeStored = Schema.decodeUnknownSync(ThreadDecision);
const COORDINATOR = ThreadId.make("coordinator");
const CHILD = ThreadId.make("child");

const input: ThreadDecisionInput = {
  id: "stichtag",
  title: "Stichtag auf Prod",
  question: "Volle Historie oder ab Stichtag?",
  options: [
    { id: "full", label: "Volle Historie", detail: "≥ 17,5 GB" },
    { id: "date", label: "Ab Stichtag" },
  ],
  recommended: { optionId: "full", reason: "  " },
  routeToThreadId: CHILD,
};

const open = (): ThreadDecision => upsertDecision(null, input, COORDINATOR, "t1");

const taskInput: ThreadDecisionInput = {
  id: "deploy-key",
  kind: "task",
  title: "Deploy-Key eintragen",
  question: "Trag den Deploy-Key im Repo unter Settings → Deploy keys ein.",
  routeToThreadId: CHILD,
};
const openTask = (): ThreadDecision => upsertDecision(null, taskInput, COORDINATOR, "t1");

describe("upsertDecision", () => {
  it("creates an open decision with defaults", () => {
    expect(open()).toMatchObject({
      status: "open",
      urgency: "today",
      recommendedOptionId: "full",
      recommendationReason: null,
      createdAt: "t1",
      options: [
        { id: "full", detail: "≥ 17,5 GB", pros: [], cons: [] },
        { id: "date", detail: null },
      ],
    });
  });

  it("asks an answered decision again and keeps when it was first asked", () => {
    const answered = applyReply(open(), { decisionId: "stichtag", optionId: "full" }, "t2");
    const again = upsertDecision(answered, input, COORDINATOR, "t3");
    expect(again).toMatchObject({ status: "open", answer: null, createdAt: "t1", updatedAt: "t3" });
  });
});

describe("tasks", () => {
  it("need no options, refuse any, and keep their kind on a later upsert", () => {
    expect(validateDecisionInput(taskInput, "task")).toBeNull();
    expect(validateDecisionInput({ ...taskInput, options: input.options }, "task")).toMatch(
      /A task has no options/,
    );
    expect(validateDecisionInput({ ...input, options: [] }, "decision")).toMatch(/kind "task"/);
    const task = openTask();
    expect(task).toMatchObject({ kind: "task", options: [], status: "open" });
    const { kind: _kind, ...withoutKind } = taskInput;
    expect(decisionKind(task, withoutKind)).toBe("task");
    expect(decisionKind(null, withoutKind)).toBe("decision");
  });

  it("are checked off with an optional note and can be reopened", () => {
    const done = applyReply(
      openTask(),
      { decisionId: "deploy-key", done: true, text: " eingetragen " },
      "t2",
    );
    expect(done).toMatchObject({
      status: "answered",
      answer: { optionId: null, text: "eingetragen" },
    });
    expect(reopenDecision(done, "t3")).toMatchObject({ status: "open", answer: null });
  });

  it("reads a decision stored before tasks existed as a decision", () => {
    const { kind: _kind, ...stored } = open();
    expect(decodeStored(stored).kind).toBe("decision");
  });

  it("only tasks can be checked off", () => {
    expect(validateReply(open(), { decisionId: "stichtag", done: true })).toMatch(/not a task/);
    expect(validateReply(openTask(), { decisionId: "deploy-key", done: true })).toBeNull();
  });
});

describe("validateDecisionInput", () => {
  it("rejects a recommendation that is not an option", () => {
    expect(
      validateDecisionInput({ ...input, recommended: { optionId: "later" } }, "decision"),
    ).toMatch(/not one of the options/);
  });

  it("rejects duplicate option ids", () => {
    expect(
      validateDecisionInput(
        {
          ...input,
          options: [
            { id: "a", label: "A" },
            { id: "a", label: "B" },
          ],
        },
        "decision",
      ),
    ).toMatch(/used twice/);
  });
});

describe("applyReply", () => {
  it("answers with an option and a reason", () => {
    const decision = applyReply(
      open(),
      { decisionId: "stichtag", optionId: "full", text: " übers Wochenende " },
      "t2",
    );
    expect(decision).toMatchObject({
      status: "answered",
      answer: { optionId: "full", text: "übers Wochenende" },
    });
  });

  it("keeps the decision open when the user asks back", () => {
    const decision = applyReply(open(), { decisionId: "stichtag", askBack: true }, "t2");
    expect(decision).toMatchObject({ status: "open", answer: null, askedBackAt: "t2" });
  });

  it("keeps the decision open when the user asks for an explanation", () => {
    const decision = applyReply(open(), { decisionId: "stichtag", explain: true }, "t2");
    expect(decision).toMatchObject({ status: "open", answer: null, askedBackAt: "t2" });
  });

  it("resolves the decision when the user dismisses it", () => {
    const decision = applyReply(
      open(),
      { decisionId: "stichtag", dismissReason: "im Gespräch geklärt" },
      "t2",
    );
    expect(decision).toMatchObject({
      status: "resolved",
      resolvedBy: "user",
      resolvedReason: "im Gespräch geklärt",
    });
  });
});

describe("validateReply", () => {
  it("refuses replies to decisions that are no longer open", () => {
    const resolved = resolveDecision(open(), "Prod-Fix löst das", "coordinator", "t2");
    expect(validateReply(resolved, { decisionId: "stichtag", optionId: "full" })).toMatch(
      /no longer open/,
    );
    expect(
      validateReply(reopenDecision(resolved, "t3"), { decisionId: "stichtag", optionId: "full" }),
    ).toBeNull();
  });

  it("refuses an unknown option", () => {
    expect(validateReply(open(), { decisionId: "stichtag", optionId: "x" })).toMatch(/no option x/);
  });
});

describe("shortenContext", () => {
  it("keeps short context in one line and cuts long context at a word", () => {
    expect(shortenContext("Zwei\n\n  Zeilen")).toBe("Zwei Zeilen");
    const long = "wort ".repeat(100);
    const short = shortenContext(long);
    expect(short.length).toBeLessThanOrEqual(302);
    expect(short).toMatch(/wort …$/);
  });
});

describe("formatDecisionReplies", () => {
  const link = (threadId: ThreadId) => `[Child](t3-thread:${threadId})`;

  it("repeats question and short context, and asks back for an explanation", () => {
    const decision = { ...open(), context: `Prod hat **17,5 GB**.\n\n${"x".repeat(400)}` };
    const text = formatDecisionReplies(
      [{ decision, reply: { decisionId: "stichtag", explain: true } }],
      link,
    );
    const lines = text.split("\n");
    expect(lines[4]).toBe("  Question: Volle Historie oder ab Stichtag?");
    expect(lines[5]).toMatch(/^ {2}Context: Prod hat \*\*17,5 GB\*\*\. x+ …$/);
    expect(lines[5]!.length).toBeLessThanOrEqual("  Context: ".length + 302);
    expect(lines[6]).toBe(
      "  Asks back: explain this in plain words – what is it about and what happens with each option?",
    );
    expect(text).not.toContain("pass it on");
  });

  it("reports a checked-off task and names the thread it is for", () => {
    const text = formatDecisionReplies(
      [{ decision: openTask(), reply: { decisionId: "deploy-key", done: true, text: "erledigt" } }],
      link,
    );
    expect(text.split("\n").slice(3, -1)).toEqual([
      "- deploy-key · Deploy-Key eintragen (task)",
      "  Task: Trag den Deploy-Key im Repo unter Settings → Deploy keys ein.",
      "  Done: erledigt",
      "  For [Child](t3-thread:child): pass it on.",
    ]);
  });

  it("lists each reply and names the thread an answer is for", () => {
    const decision = open();
    const text = formatDecisionReplies(
      [
        { decision, reply: { decisionId: "stichtag", optionId: "full", text: "übers Wochenende" } },
        { decision: { ...decision, id: "regel" }, reply: { decisionId: "regel", askBack: true } },
      ],
      (threadId) => `[Child](t3-thread:${threadId})`,
    );
    expect(text).toBe(
      [
        "<t3_decisions>",
        "The user answered in the Inbox:",
        "",
        "- stichtag · Stichtag auf Prod",
        "  Question: Volle Historie oder ab Stichtag?",
        "  Answer: Volle Historie (full). übers Wochenende",
        "  For [Child](t3-thread:child): pass it on.",
        "- regel · Stichtag auf Prod",
        "  Question: Volle Historie oder ab Stichtag?",
        "  Asks back: what speaks for and against each option?",
        "</t3_decisions>",
      ].join("\n"),
    );
  });
});
