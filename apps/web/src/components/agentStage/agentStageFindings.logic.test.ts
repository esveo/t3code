import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { contextFinding, riskyCommandTitle, trailingQuestion } from "./agentStageFindings.logic";

describe("riskyCommandTitle", () => {
  it("names commands that are hard to take back", () => {
    expect(riskyCommandTitle("cd /repo && rm -rf build")).toBe("Deletes files recursively");
    expect(riskyCommandTitle("git push --force origin main")).toBe("Force push");
    expect(riskyCommandTitle("git push -f")).toBe("Force push");
    expect(riskyCommandTitle("git reset --hard HEAD~1")).toBe("Hard reset");
    expect(riskyCommandTitle("psql -c 'DROP TABLE users'")).toBe("Drops data");
    expect(riskyCommandTitle("pnpm publish --access public")).toBe("Publishes a package");
    expect(riskyCommandTitle("sudo launchctl unload x")).toBe("Runs as root");
  });

  it("lets everyday commands pass", () => {
    expect(riskyCommandTitle("rm build/tmp.txt")).toBeNull();
    expect(riskyCommandTitle("git push origin feature")).toBeNull();
    expect(riskyCommandTitle("npx vp test run src")).toBeNull();
    expect(riskyCommandTitle(null)).toBeNull();
  });
});

describe("trailingQuestion", () => {
  it("finds the question the answer ends on", () => {
    expect(trailingQuestion("Done.\n\nShould I merge it into fork? Then I build it.")).toBe(
      "Should I merge it into fork?",
    );
    expect(trailingQuestion("All green.\n\n**Soll ich weitermachen?**")).toBe(
      "Soll ich weitermachen?",
    );
  });

  it("ignores questions earlier in the answer or inside code", () => {
    expect(trailingQuestion("Why did it fail?\n\nFixed it, tests pass.")).toBeNull();
    expect(trailingQuestion("Here:\n\n```\nwhat?\n```")).toBeNull();
  });
});

describe("contextFinding", () => {
  const usage = (payload: Record<string, unknown>): OrchestrationThreadActivity => ({
    id: EventId.make("context-1"),
    createdAt: "2026-09-21T10:00:00.000Z",
    kind: "context-window.updated",
    summary: "Context window updated",
    tone: "info",
    payload,
    turnId: TurnId.make("turn-1"),
    sequence: 1,
  });

  it("speaks up once the context is nearly full", () => {
    expect(contextFinding([usage({ usedTokens: 900, maxTokens: 1000 })], "main")).toEqual(
      expect.objectContaining({ kind: "context", title: "Context 90% full" }),
    );
    expect(contextFinding([usage({ usedTokens: 500, maxTokens: 1000 })], "main")).toBeNull();
  });

  it("measures against the compaction point when the provider compacts", () => {
    const finding = contextFinding(
      [
        usage({
          usedTokens: 180,
          maxTokens: 1000,
          compactsAutomatically: true,
          autoCompactThreshold: 200,
        }),
      ],
      "main",
    );
    expect(finding?.title).toBe("Context is about to be compacted");
  });
});
