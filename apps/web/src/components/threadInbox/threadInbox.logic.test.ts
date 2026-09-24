import { ThreadId, type ThreadDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeDraft,
  describeSettled,
  draftToReply,
  groupDecisions,
  nextUndrafted,
  orderDecisions,
  waitingDecisionCount,
} from "./threadInbox.logic";

const CHILD = ThreadId.make("child");

function decision(overrides: Partial<ThreadDecision> & { id: string }): ThreadDecision {
  return {
    coordinatorThreadId: ThreadId.make("coordinator"),
    kind: "decision",
    title: overrides.id,
    question: "?",
    context: null,
    options: [
      { id: "yes", label: "Ja", detail: null, pros: [], cons: [] },
      { id: "no", label: "Nein", detail: null, pros: [], cons: [] },
    ],
    recommendedOptionId: null,
    recommendationReason: null,
    urgency: "today",
    sourceThreadId: null,
    routeToThreadId: null,
    dependsOn: [],
    status: "open",
    answer: null,
    resolvedReason: null,
    resolvedBy: null,
    snoozedAt: null,
    askedBackAt: null,
    createdAt: "t0",
    updatedAt: "t0",
    ...overrides,
  };
}

describe("orderDecisions", () => {
  it("puts urgent decisions first and each after what it depends on", () => {
    const ordered = orderDecisions([
      decision({ id: "regel", urgency: "now", dependsOn: ["stichtag"] }),
      decision({ id: "stichtag", urgency: "today" }),
      decision({ id: "kodierung", urgency: "now" }),
      decision({ id: "issues", urgency: "later" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["stichtag", "regel", "kodierung", "issues"]);
  });

  it("leaves out answered, resolved and snoozed decisions", () => {
    const decisions = [
      decision({ id: "open" }),
      decision({ id: "answered", status: "answered" }),
      decision({ id: "resolved", status: "resolved" }),
      decision({ id: "snoozed", snoozedAt: "t1" }),
    ];
    expect(orderDecisions(decisions).map((entry) => entry.id)).toEqual(["open"]);
    expect(waitingDecisionCount(decisions)).toBe(1);
  });

  it("survives a dependency cycle", () => {
    const ordered = orderDecisions([
      decision({ id: "a", dependsOn: ["b"] }),
      decision({ id: "b", dependsOn: ["a"] }),
    ]);
    expect(ordered.map((entry) => entry.id).toSorted()).toEqual(["a", "b"]);
  });
});

describe("groupDecisions", () => {
  it("groups by the thread a question comes from, the coordinator's own under its title", () => {
    const groups = groupDecisions(
      [decision({ id: "a", sourceThreadId: CHILD }), decision({ id: "b" })],
      "thread",
      () => "FF2 Dev-DB",
      "Coordinator title",
    );
    expect(groups.map((group) => [group.label, group.decisions.length])).toEqual([
      ["FF2 Dev-DB", 1],
      ["Coordinator title", 1],
    ]);
  });
});

describe("nextUndrafted", () => {
  it("skips decisions that already have a reply and wraps around", () => {
    const ordered = [decision({ id: "a" }), decision({ id: "b" }), decision({ id: "c" })];
    expect(nextUndrafted(ordered, "a", { b: { optionId: "yes" } })?.id).toBe("c");
    expect(nextUndrafted(ordered, "c", { b: { optionId: "yes" } })?.id).toBe("a");
  });
});

describe("drafts", () => {
  it("turns a draft into a reply and leaves out an empty one", () => {
    expect(draftToReply("a", { optionId: "yes", text: "  weil  " })).toEqual({
      decisionId: "a",
      optionId: "yes",
      text: "weil",
    });
    expect(draftToReply("a", { text: "   " })).toBeNull();
  });

  it("describes a draft in the user's words", () => {
    const entry = decision({ id: "a" });
    expect(describeDraft(entry, { optionId: "yes", text: "übers Wochenende" })).toBe(
      "Ja – übers Wochenende",
    );
    expect(describeDraft(entry, { askBack: true })).toBe("Asks for pros and cons");
    expect(describeDraft(entry, { dismissReason: "geklärt" })).toBe("Done: geklärt");
  });

  it("checks off a task and asks for an explanation", () => {
    const task = decision({ id: "key", kind: "task", options: [] });
    expect(draftToReply("key", { done: true, text: " eingetragen " })).toEqual({
      decisionId: "key",
      done: true,
      text: "eingetragen",
    });
    expect(describeDraft(task, { done: true })).toBe("Done");
    expect(describeDraft(task, { explain: true })).toBe("Asks to explain");
    expect(draftToReply("key", { explain: true })).toEqual({ decisionId: "key", explain: true });
    expect(
      describeSettled({ ...task, status: "answered", answer: { optionId: null, text: null } }),
    ).toBe("Done");
  });
});
