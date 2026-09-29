import { describe, expect, it } from "vite-plus/test";

import { collectEvidence, orderEvidence, rollbackReport } from "./evidence.ts";

describe("preflight evidence", () => {
  it("always puts hard results first and the model's own view last", () => {
    expect(
      orderEvidence([
        { kind: "model", text: "sure" },
        { kind: "rollbacks", text: "r" },
        { kind: "run", text: "a" },
        { kind: "hard", text: "h" },
        { kind: "run", text: "b" },
      ]).map((item) => item.text),
    ).toEqual(["h", "a", "b", "r", "sure"]);

    const evidence = collectEvidence({
      tasks: [],
      earlier: [],
      actionHash: "x",
      modelAssessment: "I am confident",
    });
    expect(evidence.map((item) => item.kind)).toEqual(["hard", "run", "rollbacks", "model"]);
    expect(evidence[3]?.text).toBe("I am confident");
  });

  it("counts rolled-back work per thread and provider, out of approved and finished work", () => {
    const report = rollbackReport({
      observations: [
        { threadId: "a" as never, provider: "codex", decision: "accept", rolledBackBy: "person:r" },
        { threadId: "a" as never, provider: "codex", decision: "decline", rolledBackBy: null },
        { threadId: "b" as never, provider: "codex", decision: "accept", rolledBackBy: null },
      ],
      tasks: [
        { type: "task", threadId: "c" as never, status: "done", rolledBackBy: "person:r" },
        { type: "task", threadId: "c" as never, status: "running", rolledBackBy: null },
      ],
      providerOf: (threadId) => (threadId === "c" ? "claudeAgent" : null),
    });
    expect(report.byProvider.get("codex")).toEqual({ rolledBack: 1, base: 2 });
    expect(report.byProvider.get("claudeAgent")).toEqual({ rolledBack: 1, base: 1 });
    expect(report.threads.map((thread) => thread.threadId).toSorted()).toEqual(["a", "c"]);
  });
});
