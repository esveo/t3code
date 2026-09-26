import { describe, expect, it } from "vite-plus/test";

import {
  initiativeRuntimeMode,
  initiativeStartPrompt,
  mayUseTool,
  SESSION_STALL_LIMIT_MS,
  sessionStateOf,
  type SessionStateShell,
} from "./index.ts";

const shell = (overrides: Partial<SessionStateShell>): SessionStateShell => ({
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestTurn: null,
  pullRequests: [],
  planProgress: null,
  backgroundLiveness: null,
  updatedAt: "2026-09-26T10:00:00.000Z",
  ...overrides,
});

describe("initiativeRuntimeMode", () => {
  it("runs initiative threads in auto, with accept-edits where no reviewer exists", () => {
    expect(initiativeRuntimeMode("codex")).toBe("auto");
    expect(initiativeRuntimeMode("claudeAgent")).toBe("auto");
    expect(initiativeRuntimeMode("opencode")).toBe("auto-accept-edits");
    expect(initiativeRuntimeMode("antigravity")).toBe("auto-accept-edits");
    // An unknown instance still never falls back to full access.
    expect(initiativeRuntimeMode(null)).toBe("auto");
  });
});

describe("mayUseTool", () => {
  it("keeps writing tools with the coordinator and reading with every member", () => {
    expect(mayUseTool("initiative_list", null)).toBe(true);
    expect(mayUseTool("initiative_brief", null)).toBe(false);
    expect(mayUseTool("initiative_brief", "participant")).toBe(true);
    expect(mayUseTool("initiative_start_thread", "participant")).toBe(false);
    expect(mayUseTool("initiative_start_thread", "coordinator")).toBe(true);
    expect(mayUseTool("session_unassign", "participant")).toBe(false);
  });
});

describe("sessionStateOf", () => {
  const now = Date.parse("2026-09-26T10:05:00.000Z");
  const running = {
    status: "running",
    updatedAt: "2026-09-26T10:00:00.000Z",
  } as SessionStateShell["session"];

  it("calls a working thread stalled once nothing changed for the stall limit", () => {
    expect(sessionStateOf(shell({ session: running }), now)).toBe("running");
    expect(sessionStateOf(shell({ session: running }), now + SESSION_STALL_LIMIT_MS)).toBe(
      "stalled",
    );
  });

  it("reads waiting, done and a missing thread", () => {
    expect(sessionStateOf(shell({ hasPendingApprovals: true }), now)).toBe("waiting");
    expect(sessionStateOf(shell({}), now)).toBe("done");
    expect(sessionStateOf(null, now)).toBe("unknown");
  });
});

describe("initiativeStartPrompt", () => {
  it("puts the initiative's goal and instructions ahead of the task", () => {
    const text = initiativeStartPrompt({
      initiative: {
        id: "i1",
        title: 'A "quoted" title',
        goalText: "Ship",
        instructionsMd: "Be brief.",
      },
      role: "participant",
      prompt: "Do the thing",
    });
    expect(text).toContain(
      '<t3_initiative id="i1" title="A &quot;quoted&quot; title" role="participant">',
    );
    expect(text).toContain("Goal: Ship");
    expect(text).toContain("Instructions:\nBe brief.");
    expect(text.endsWith("Do the thing")).toBe(true);
  });
});
