import { describe, expect, it } from "vite-plus/test";

import { claudeTaskType } from "./claudeWatchTaskType.ts";

describe("claudeTaskType", () => {
  it("reports a Monitor tool's shell task as a monitor", () => {
    expect(claudeTaskType("local_bash", "Monitor")).toBe("monitor");
    expect(claudeTaskType(undefined, "Monitor")).toBe("monitor");
  });

  it("keeps every other task type", () => {
    expect(claudeTaskType("local_bash", "Bash")).toBe("local_bash");
    expect(claudeTaskType("local_bash", undefined)).toBe("local_bash");
    expect(claudeTaskType("monitor_ws", "Artifact")).toBe("monitor_ws");
    expect(claudeTaskType("monitor_mcp", "Monitor")).toBe("monitor_mcp");
  });
});
