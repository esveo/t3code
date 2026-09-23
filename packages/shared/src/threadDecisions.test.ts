import { ThreadId, type ThreadDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyReply,
  formatDecisionReplies,
  reopenDecision,
  resolveDecision,
  upsertDecision,
  validateDecisionInput,
  validateReply,
  type ThreadDecisionInput,
} from "./threadDecisions.ts";

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

describe("validateDecisionInput", () => {
  it("rejects a recommendation that is not an option", () => {
    expect(validateDecisionInput({ ...input, recommended: { optionId: "later" } })).toMatch(
      /not one of the options/,
    );
  });

  it("rejects duplicate option ids", () => {
    expect(
      validateDecisionInput({
        ...input,
        options: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      }),
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

describe("formatDecisionReplies", () => {
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
        "  Answer: Volle Historie (full). übers Wochenende",
        "  For [Child](t3-thread:child): pass it on.",
        "- regel · Stichtag auf Prod",
        "  Asks back: what speaks for and against each option?",
        "</t3_decisions>",
      ].join("\n"),
    );
  });
});
