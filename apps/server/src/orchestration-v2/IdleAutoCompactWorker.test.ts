import { assert, it } from "@effect/vitest";
import {
  DEFAULT_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  DEFAULT_IDLE_AUTO_COMPACT_CONTEXT_TOKENS,
  isIdleAutoCompactMessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  idleAutoCompactDecision,
  type IdleAutoCompactPreferences,
  type IdleAutoCompactRecords,
  type IdleAutoCompactShell,
} from "./IdleAutoCompactWorker.ts";

const minute = 60_000;
const lastResponseMs = Date.parse("2026-10-01T10:00:00.000Z");
const after = (minutes: number) => lastResponseMs + minutes * minute;
const lastResponseIso = DateTime.formatIso(DateTime.makeUnsafe(lastResponseMs));

const preferences: IdleAutoCompactPreferences = {
  enableIdleAutoCompact: true,
  idleAutoCompactAfterMinutes: DEFAULT_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  idleAutoCompactMinContextTokens: DEFAULT_IDLE_AUTO_COMPACT_CONTEXT_TOKENS,
};

const shell = (overrides: Partial<IdleAutoCompactShell> = {}) =>
  ({
    id: ThreadId.make("thread-1"),
    // A finished thread's shell carries its latest run's status, never "idle".
    status: "completed",
    activeRunId: null,
    activeProviderThreadId: "pt-1",
    latestRunId: "run-1",
    latestRunCompletedAt: DateTime.makeUnsafe(lastResponseMs),
    latestUserMessageAt: DateTime.makeUnsafe(lastResponseMs - 5 * minute),
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    ...overrides,
  }) as IdleAutoCompactShell;

const records = (input: {
  readonly usedTokens?: number;
  readonly ttl?: "5m" | "1h" | null;
  readonly driver?: string;
  readonly subagentUsage?: boolean;
}) => {
  const tokenUsage = {
    usedTokens: input.usedTokens ?? 400_000,
    ...(input.ttl === null
      ? {}
      : {
          promptCache: {
            ttl: input.ttl ?? "1h",
            refreshedAt: lastResponseIso,
          },
        }),
    updatedAt: lastResponseIso,
  };
  return {
    providerThreads: [
      {
        id: "pt-1",
        driver: input.driver ?? "claudeAgent",
        nativeThreadRef: { nativeId: "native-1" },
      },
    ],
    attempts: [{ id: "attempt-1", nativeThreadId: "native-1", rootNodeId: "root" }],
    providerTurns: [
      {
        providerThreadId: "pt-1",
        runAttemptId: "attempt-1",
        nodeId: input.subagentUsage ? "subagent" : "root",
        tokenUsage,
      },
    ],
  } as unknown as IdleAutoCompactRecords;
};

const decide = (input: {
  readonly nowMs: number;
  readonly shell?: IdleAutoCompactShell;
  readonly records?: IdleAutoCompactRecords;
  readonly preferences?: IdleAutoCompactPreferences;
}) =>
  idleAutoCompactDecision({
    shell: input.shell ?? shell(),
    records: () => input.records ?? records({}),
    preferences: input.preferences ?? preferences,
    nowMs: input.nowMs,
  });

const command = (input: Parameters<typeof decide>[0]) => decide(input).command;

it("compacts a large idle Claude thread shortly before its 1h cache expires", () => {
  const result = command({ nowMs: after(56) });
  assert.strictEqual(result?.type, "message.dispatch");
  if (result?.type !== "message.dispatch") return;
  assert.strictEqual(result.text, "/compact");
  assert.strictEqual(result.dispatchMode.type, "start_immediately");
  assert.isTrue(isIdleAutoCompactMessageId(result.messageId));
});

it("waits for the idle time and gives up once the cache expired", () => {
  assert.isNull(command({ nowMs: after(54) }));
  assert.isNull(command({ nowMs: after(60) }));
});

it("compacts a finished 173k thread on a 1h cache 56 minutes after its last response", () => {
  const decision = decide({ nowMs: after(56), records: records({ usedTokens: 173_000 }) });
  assert.strictEqual(decision.command?.type, "message.dispatch");
  assert.strictEqual(decision.contextTokens, 173_000);
  assert.strictEqual(decision.cacheTtl, "1h");
  assert.strictEqual(decision.idleMinutes, 56);
});

it("names why it skips a 173k thread at 56 minutes", () => {
  const at56 = (input: Omit<Parameters<typeof decide>[0], "nowMs">) =>
    decide({ nowMs: after(56), ...input }).skipReason;
  assert.strictEqual(at56({ records: records({ usedTokens: 173_000, ttl: "5m" }) }), "ttl-not-1h");
  assert.strictEqual(at56({ records: records({ usedTokens: 149_999 }) }), "below-min-context");
  assert.strictEqual(
    at56({
      shell: shell({ status: "running", activeRunId: "run-2" } as Partial<IdleAutoCompactShell>),
      records: records({ usedTokens: 173_000 }),
    }),
    "run-active",
  );
  assert.strictEqual(at56({ shell: shell({ status: "idle", latestRunId: null }) }), "no-run");
});

it("compacts after any finished run, not only a completed one", () => {
  for (const status of ["interrupted", "failed", "cancelled"] as const) {
    assert.isNotNull(command({ nowMs: after(56), shell: shell({ status }) }));
  }
  assert.isNull(command({ nowMs: after(56), shell: shell({ status: "queued" }) }));
});

it("leaves the thread alone when disabled", () => {
  assert.isNull(
    command({ nowMs: after(56), preferences: { ...preferences, enableIdleAutoCompact: false } }),
  );
});

it("only compacts Claude threads on a 1h cache above the threshold", () => {
  assert.isNull(command({ nowMs: after(56), records: records({ ttl: "5m" }) }));
  assert.isNull(command({ nowMs: after(56), records: records({ ttl: null }) }));
  assert.isNull(command({ nowMs: after(56), records: records({ usedTokens: 100_000 }) }));
  assert.isNull(command({ nowMs: after(56), records: records({ driver: "codex" }) }));
  assert.isNull(command({ nowMs: after(56), records: records({ subagentUsage: true }) }));
});

it("skips busy, waiting, archived and settled threads", () => {
  const blocked: ReadonlyArray<Partial<IdleAutoCompactShell>> = [
    { status: "running" },
    { activeRunId: "run-2" } as Partial<IdleAutoCompactShell>,
    { pendingRuntimeRequest: {} } as Partial<IdleAutoCompactShell>,
    { pendingBackgroundTasks: [{}] } as unknown as Partial<IdleAutoCompactShell>,
    { archivedAt: DateTime.makeUnsafe(lastResponseMs) },
    { settledOverride: "settled" },
  ];
  for (const overrides of blocked) {
    assert.isNull(command({ nowMs: after(56), shell: shell(overrides) }));
  }
});

it("measures idle time from the latest user message too", () => {
  const recentMessage = shell({ latestUserMessageAt: DateTime.makeUnsafe(after(10)) });
  assert.isNull(command({ nowMs: after(56), shell: recentMessage }));
});

it("derives one identity per cache window, so a repeat sweep cannot compact twice", () => {
  const first = command({ nowMs: after(55) });
  const second = command({ nowMs: after(58) });
  assert.isNotNull(first);
  assert.strictEqual(first?.commandId, second?.commandId);
});

it("does not compact again after a compact until the thread is used", () => {
  // The compact boundary reports the summary size without a cache window.
  assert.isNull(command({ nowMs: after(56), records: records({ usedTokens: 20_000, ttl: null }) }));
});
