import { describe, expect, it } from "vite-plus/test";

import { checkStateOf, taskDoneBlocker } from "./checks.ts";

const passed = {
  outcome: "passed" as const,
  evidence: { excerpt: "0 failed", url: null, commit: null },
  reportedBy: "role:participant:worker",
  reportedAt: "2026-09-29T10:00:00.000Z",
};
const check = {
  kind: "criterion" as const,
  description: "Spam is rejected",
  ref: null,
  expected: null,
};
const task = { type: "task" as const, inbox: null };

describe("taskDoneBlocker", () => {
  it("holds a task back until its latest check passed or a person accepted it", () => {
    expect(taskDoneBlocker(task)).toContain("no acceptance check");
    expect(taskDoneBlocker({ ...task, acceptanceCheck: check })).toContain("not been reported");
    expect(
      taskDoneBlocker({
        ...task,
        acceptanceCheck: check,
        checkResults: [passed, { ...passed, outcome: "failed" }],
      }),
    ).toContain("failed last");
    expect(taskDoneBlocker({ ...task, acceptanceCheck: check, checkResults: [passed] })).toBeNull();
    expect(taskDoneBlocker({ ...task, acceptedWithoutCheckBy: "person:robert" })).toBeNull();
  });

  it("leaves Inbox tasks and plans alone", () => {
    expect(
      taskDoneBlocker({ type: "task", inbox: { threadId: "c" as never, itemId: "i" } }),
    ).toBeNull();
    expect(taskDoneBlocker({ type: "plan", inbox: null })).toBeNull();
  });

  it("names where a check stands", () => {
    expect(checkStateOf(task)).toBe("missing");
    expect(checkStateOf({ ...task, acceptanceCheck: check })).toBe("pending");
    expect(checkStateOf({ ...task, acceptanceCheck: check, checkResults: [passed] })).toBe(
      "passed",
    );
    expect(checkStateOf({ ...task, acceptedWithoutCheckBy: "person:robert" })).toBe(
      "acceptedWithout",
    );
  });
});
