import { describe, expect, it } from "vite-plus/test";

import { buildSubagentRelayMessage } from "./subagentRelay.logic";

describe("buildSubagentRelayMessage", () => {
  it("addresses the subagent by title and id and fences the user's text", () => {
    const text = buildSubagentRelayMessage(
      { agentId: "task-7", title: "Review the diff" },
      "  also check the tests \n",
    );
    expect(text).toContain('your subagent "Review the diff" (id: task-7)');
    expect(text.endsWith("<message>\nalso check the tests\n</message>")).toBe(true);
  });

  it("falls back to the id when the subagent has no title", () => {
    expect(buildSubagentRelayMessage({ agentId: "task-7", title: null }, "hi")).toContain(
      "your subagent (id: task-7)",
    );
  });
});
