import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  batchCount,
  batchWeight,
  estimateImportCost,
  IMPORT_FALLBACK_CALL_COST_USD,
  IMPORT_MAX_MESSAGES,
  REPLY_EXCERPT_MAX_CHARS,
  selectPastMessages,
} from "./importPast.ts";
import type { UsageRecord } from "./store.ts";
import { DAY_MS, toIso } from "./time.ts";

const NOW = Date.UTC(2026, 9, 8, 12);

const msg = (
  id: string,
  minutesAgo: number,
  overrides: Partial<Record<string, unknown>> = {},
): OrchestrationV2ConversationMessage =>
  ({
    id,
    threadId: "thread-1",
    runId: null,
    nodeId: null,
    role: "user",
    createdBy: "user",
    creationSource: "web",
    text: `Bitte ${id} erledigen`,
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(NOW - minutesAgo * 60_000),
    updatedAt: DateTime.makeUnsafe(NOW - minutesAgo * 60_000),
    ...overrides,
  }) as unknown as OrchestrationV2ConversationMessage;

const reply = (id: string, minutesAgo: number, text: string) =>
  msg(id, minutesAgo, { role: "assistant", createdBy: "agent", creationSource: "provider", text });

const usageRecord = (purpose: UsageRecord["purpose"], costUsd: number, ok = true): UsageRecord => ({
  ts: toIso(NOW),
  purpose,
  model: "claude-haiku-4-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd,
  costEstimated: false,
  durationMs: 1000,
  ok,
});

describe("selectPastMessages", () => {
  it("takes only what the user typed, from the last 30 days, and not yet known", () => {
    const records = selectPastMessages(
      [
        {
          projectId: "project-1",
          messages: [
            msg("typed", 10),
            msg("mobile", 9, { creationSource: "mobile" }),
            msg("agent", 8, { createdBy: "agent" }),
            msg("scheduled", 7, { scheduledTaskId: "task-1" }),
            msg("sent-by-thread", 6, { senderThreadId: "thread-2" }),
            msg("slash", 5, { text: "  /compact" }),
            msg("api", 4, { creationSource: "server" }),
            msg("known", 3),
            msg("old", 31 * 24 * 60),
          ],
        },
      ],
      { now: NOW, knownIds: new Set(["known"]) },
    );
    assert.deepEqual(
      records.map((record) => record.messageId),
      ["typed", "mobile"],
    );
    assert.strictEqual(records[0]?.ts, toIso(NOW - 10 * 60_000));
    assert.strictEqual(records[0]?.projectId, "project-1");
  });

  it("keeps the newest 300, oldest first, across threads", () => {
    const thread = (prefix: string, offset: number) => ({
      projectId: null,
      messages: Array.from({ length: 200 }, (_, index) =>
        msg(`${prefix}-${index}`, offset + index * 2),
      ),
    });
    const records = selectPastMessages([thread("a", 0), thread("b", 1)], {
      now: NOW,
      knownIds: new Set(),
    });
    assert.strictEqual(records.length, IMPORT_MAX_MESSAGES);
    assert.strictEqual(records.at(-1)?.messageId, "a-0");
    assert.strictEqual(records[0]?.messageId, "b-149");
    assert.isTrue(
      records.every((record, index) => index === 0 || records[index - 1]!.ts <= record.ts),
    );
  });

  it("adds the redacted end of the agent reply the message answered", () => {
    const long = `${"Erklärung ".repeat(40)}Token sk-ant-abcdefghijklmnop1234. Soll ich committen?`;
    const records = selectPastMessages(
      [
        {
          projectId: null,
          messages: [
            msg("first", 30),
            reply("reply-1", 20, long),
            msg("system", 15, { role: "system", createdBy: "server", text: "Run finished" }),
            msg("answer", 10),
            msg("again", 5),
          ],
        },
      ],
      { now: NOW, knownIds: new Set() },
    );
    const byId = new Map(records.map((record) => [record.messageId, record]));
    assert.isUndefined(byId.get("first")?.reply);
    assert.isUndefined(byId.get("again")?.reply);
    const answered = byId.get("answer")?.reply ?? "";
    assert.isAtMost(answered.length, REPLY_EXCERPT_MAX_CHARS);
    assert.isTrue(answered.endsWith("Soll ich committen?"));
    assert.include(answered, "[REDACTED:ANTHROPIC_KEY]");
    assert.notInclude(answered, "sk-ant-");
  });
});

describe("batchWeight", () => {
  it("halves a batch whose median message is 30 days old", () => {
    const at = (days: number) => ({ ts: toIso(NOW - days * DAY_MS) });
    assert.closeTo(batchWeight([at(29), at(30), at(31)], NOW), 0.5, 1e-9);
    assert.closeTo(batchWeight([at(0), at(0)], NOW), 1, 1e-9);
    assert.closeTo(batchWeight([at(10), at(20)], NOW), 0.5 ** (15 / 30), 1e-9);
  });
});

describe("estimateImportCost", () => {
  it("multiplies the batches by the average successful learning call", () => {
    assert.strictEqual(batchCount(0), 0);
    assert.strictEqual(batchCount(31), 2);
    assert.closeTo(estimateImportCost([], 2), 2 * IMPORT_FALLBACK_CALL_COST_USD, 1e-9);
    assert.closeTo(
      estimateImportCost(
        [
          usageRecord("distill", 0.02),
          usageRecord("import", 0.04),
          usageRecord("suggest", 0.5),
          usageRecord("distill", 0.9, false),
        ],
        10,
      ),
      0.3,
      1e-9,
    );
  });
});
