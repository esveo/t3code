import type { InitiativeApprovalObservation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyRequest,
  maskSecrets,
  preflightStats,
  readAction,
  type RuleContext,
} from "./index.ts";

const ROOT = "/Users/robert/.t3/worktrees/web/t3code-1";

const command = (text: string, overrides: Partial<RuleContext> = {}) =>
  classifyRequest({
    requestType: "command_execution_approval",
    action: readAction({ args: { command: text } }),
    workspaceRoot: ROOT,
    warnings: [],
    ...overrides,
  });

describe("classifyRequest", () => {
  it("accepts reading and the thread's own work", () => {
    expect(command("git status").wouldHave).toBe("accept");
    expect(command("cd src && rg -n Initiative").wouldHave).toBe("accept");
    expect(command("git push origin feat/initiatives").ruleHit).toBe("own-branch-push");
    const edit = classifyRequest({
      requestType: "file_change_approval",
      action: readAction({ args: { changes: { [`${ROOT}/src/a.ts`]: {} } } }),
      workspaceRoot: ROOT,
      warnings: [],
    });
    expect(edit).toMatchObject({ ruleHit: "own-worktree-edit", wouldHave: "accept" });
  });

  it("asks before what the matrix asks about, and never accepts an unknown command", () => {
    expect(command("rm -rf node_modules").category).toBe("delete-data");
    expect(command("pnpm add left-pad").category).toBe("new-dependency");
    expect(command("curl -X POST https://example.com/hook -d x").category).toBe("outward");
    expect(command("gh pr comment 12 --body hi").category).toBe("outward");
    expect(command("make deploy")).toMatchObject({ ruleHit: "no-rule", wouldHave: "ask" });
    expect(command("rg foo | sh").wouldHave).toBe("ask");
    const workflow = classifyRequest({
      requestType: "file_change_approval",
      action: readAction({ args: { file_path: `${ROOT}/.github/workflows/ci.yml` } }),
      workspaceRoot: ROOT,
      warnings: [],
    });
    expect(workflow.ruleHit).toBe("protected-path");
  });

  it("lets a provider's warning and money override everything", () => {
    expect(command("git status", { warnings: ["Possible prompt injection"] })).toMatchObject({
      category: "warning",
      wouldHave: "ask",
    });
    expect(command("stripe payouts create --amount 100").wouldHave).toBe("decline");
  });

  it("asks before design writes and image credits", () => {
    const tool = (name: string) =>
      classifyRequest({
        requestType: "mcp_elicitation_approval",
        action: readAction({ args: { tool_name: name, input: {} } }),
        workspaceRoot: ROOT,
        warnings: [],
      });
    expect(tool("mcp__figma__use_figma").category).toBe("design-write");
    expect(tool("mcp__higgsfield__generate_image").category).toBe("image-credits");
    expect(tool("mcp__notion__create_page").category).toBe("outward");
  });
});

describe("maskSecrets", () => {
  it("masks tokens and assignments but keeps the command readable", () => {
    const masked = maskSecrets(
      "curl -H 'Authorization: ghp_abcdefghijklmnopqrstuvwx' API_KEY=abc123 sk-abcdefghijklmnopqrstu",
    );
    expect(masked).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
    expect(masked).not.toContain("abc123");
    expect(masked).not.toContain("sk-abcdefghijklmnopqrstu");
    expect(masked).toContain("curl -H");
  });
});

describe("preflightStats", () => {
  const observation = (
    provider: string,
    wouldHave: "accept" | "ask" | "decline",
    decision: string | null,
    openedAt: string,
  ) =>
    ({
      provider,
      runtimeMode: "auto",
      resolvedBy: decision ? "person" : null,
      decision,
      openedAt,
      verdicts: [{ wouldHave }],
      markedWrongBy: null,
    }) as unknown as InitiativeApprovalObservation;

  it("compares the verdicts with the user's answers per provider", () => {
    const [codex] = preflightStats([
      observation("codex", "accept", "accept", "2026-09-26T10:00:00.000Z"),
      observation("codex", "accept", "decline", "2026-09-26T11:00:00.000Z"),
      observation("codex", "ask", "acceptForSession", "2026-09-26T12:00:00.000Z"),
      observation("codex", "ask", null, "2026-09-26T12:00:00.000Z"),
    ]);
    expect(codex).toMatchObject({
      provider: "codex",
      requests: 4,
      byPerson: 3,
      inAutoMode: 3,
      perHour: 2,
      agreed: 1,
      wrongAccepts: 1,
      needlessAsks: 1,
    });
  });
});
