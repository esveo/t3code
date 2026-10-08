import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import { isObservableUserMessage, makeSeenIds, messageFeatures, toEvidence } from "./evidence.ts";
import { userMessageEvent } from "./userInsights.testkit.ts";

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");

describe("isObservableUserMessage", () => {
  it("accepts a finished message typed on web or mobile", () => {
    expect(isObservableUserMessage(userMessageEvent())).toBe(true);
    expect(isObservableUserMessage(userMessageEvent({ creationSource: "mobile" }))).toBe(true);
  });

  it.each([
    ["an agent", { createdBy: "agent" }],
    ["the system", { createdBy: "system" }],
    ["MCP", { creationSource: "mcp" }],
    ["a provider", { creationSource: "provider" }],
    ["the server", { creationSource: "server" }],
    ["a scheduled task", { scheduledTaskId: "task-1" }],
    ["another thread", { senderThreadId: "thread-2" }],
    ["a streaming message", { streaming: true }],
    ["an assistant message", { role: "assistant" }],
  ])("rejects messages from %s", (_label, overrides) => {
    expect(isObservableUserMessage(userMessageEvent(overrides))).toBe(false);
  });

  it("rejects slash commands and other event types", () => {
    expect(isObservableUserMessage(userMessageEvent({}, "/compact"))).toBe(false);
    expect(
      isObservableUserMessage({ ...userMessageEvent(), type: "thread.archived" } as never),
    ).toBe(false);
  });
});

describe("makeSeenIds", () => {
  it("reports each id once and forgets the oldest past its capacity", () => {
    const isNew = makeSeenIds(2);
    expect(isNew("a")).toBe(true);
    expect(isNew("a")).toBe(false);
    isNew("b");
    isNew("c");
    expect(isNew("a")).toBe(true);
  });
});

describe("toEvidence", () => {
  const now = DateTime.toEpochMillis(at);

  it("keeps a redacted excerpt of a typed message", () => {
    const record = toEvidence({
      message: { id: "m" as never, threadId: "t" as never, text: "Mail paul@example.com bitte?" },
      projectId: "p",
      now,
    });
    expect(record).toMatchObject({
      ts: "2026-10-01T10:00:00.000Z",
      projectId: "p",
      lang: "de",
      endsWithQuestion: true,
      excerpt: "Mail [REDACTED:EMAIL] bitte?",
    });
  });

  it("keeps only features of pasted content", () => {
    const record = toEvidence({
      message: { id: "m" as never, threadId: "t" as never, text: "x ".repeat(3000) },
      projectId: null,
      now,
    });
    expect(record.excerpt).toBeUndefined();
    expect(record.words).toBe(3000);
  });

  it("notices code and paths", () => {
    expect(messageFeatures("Check `foo()` in apps/web/src/main.ts")).toMatchObject({
      hasCode: true,
      hasPath: true,
      lang: "other",
    });
  });
});
