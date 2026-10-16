import { describe, expect, it } from "@effect/vitest";

import { classifyCommand, classifyItem, classifyTool } from "./agentTimeClassifier.ts";

describe("classifyCommand", () => {
  it.each([
    ["cd /repo && npx vp test run src/a.test.ts", "tests"],
    ["docker exec -u node app npx vitest run", "tests"],
    ["pytest -q tests/", "tests"],
    ["cd apps/web && npx tsc --noEmit", "build"],
    ["npx vp lint src/a.ts", "build"],
    ["npx pnpm@11.10.0 install", "build"],
    ["pnpm run build", "build"],
    ["git status && git diff --stat", "gitCi"],
    ["until gh pr checks 12 | grep -qv pending; do sleep 30; done", "gitCi"],
    ["gh run watch 123", "gitCi"],
    ["sqlite3 -readonly ~/db.sqlite 'select 1'", "database"],
    ["docker exec db psql -c 'select 1'", "database"],
    ["npx playwright screenshot http://localhost:3000 out.png", "browser"],
    ["sleep 60", "waiting"],
    ["until [ -f done ]; do sleep 5; done", "waiting"],
    ["cat a.ts | grep foo | head -20", "files"],
    ["S=/tmp/x; ls $S && wc -l $S/a", "files"],
    ["docker compose up -d", "jobs"],
    ["python3 scripts/analyse.py", "jobs"],
  ] as const)("%s -> %s", (command, category) => {
    expect(classifyCommand(command)).toBe(category);
  });

  it("prefers the more expensive work in a compound command", () => {
    expect(classifyCommand("npx vp lint a.ts && git commit -m x")).toBe("build");
    expect(classifyCommand("npx vitest run && npx tsc --noEmit")).toBe("tests");
  });
});

describe("classifyTool", () => {
  it.each([
    ["Read", "files"],
    ["Edit", "files"],
    ["mcp__t3-code__preview_snapshot", "browser"],
    ["mcp__cua-driver__click", "browser"],
    ["mcp__t3-code__t3_thread_wait", "children"],
    ["mcp__notion__notion-fetch", "otherTools"],
    ["ToolSearch", "otherTools"],
  ] as const)("%s -> %s", (tool, category) => {
    expect(classifyTool(tool)).toBe(category);
  });
});

describe("classifyItem", () => {
  it("names the item kinds that take time of their own", () => {
    expect(classifyItem({ type: "reasoning" })).toBe("modelThinking");
    expect(classifyItem({ type: "compaction" })).toBe("compactionErrors");
    expect(classifyItem({ type: "error" })).toBe("compactionErrors");
    expect(classifyItem({ type: "subagent" })).toBe("children");
    expect(classifyItem({ type: "file_change" })).toBe("files");
    expect(classifyItem({ type: "assistant_message" })).toBeNull();
    expect(classifyItem({ type: "notification" })).toBeNull();
  });
});
