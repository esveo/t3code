import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type UserInsightsSnapshot,
  type UserInsightsTrait,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tool from "effect/ai/Tool";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import {
  type UserInsightsReadResult,
  UserInsightsToolkit,
  UserInsightsToolkitHandlersLive,
} from "./mcpTool.ts";
import { UserInsights } from "./UserInsights.ts";

const trait = (
  id: UserInsightsTrait["id"],
  confidence: number,
  pinned = false,
): UserInsightsTrait => ({
  id,
  value: `value of ${id}`,
  support: 10,
  contradict: 1,
  confidence,
  lastSeen: "2026-10-08T12:00:00.000Z",
  pinned,
  examples: ["message-1"],
});

const snapshot = (status: UserInsightsSnapshot["status"]): UserInsightsSnapshot => ({
  status,
  traits: [trait("style.language", 0.9), trait("style.tone", 0.6, true), trait("work.stack", 0.3)],
  usage: {
    today: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    last7Days: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    total: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    lastDistillAt: null,
    dailyCapUsd: 0.5,
    maxDistillsPerDay: 12,
    maxSuggestsPerDay: 60,
  },
  folderPath: "/tmp/user-insights",
  hasStoredData: true,
});

const threadCaller: McpInvocationContext.McpInvocationContext["Service"] = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
};

const read = (options: {
  readonly insights: UserInsightsSnapshot | null;
  readonly caller?: McpInvocationContext.McpInvocationContext["Service"];
}) => {
  const service =
    options.insights === null
      ? Layer.empty
      : Layer.mock(UserInsights)({ snapshot: Effect.succeed(options.insights) });
  return Effect.gen(function* () {
    const toolkit = yield* UserInsightsToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(UserInsightsToolkitHandlersLive)),
    );
    return yield* toolkit.handle("user_insights_read", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as UserInsightsReadResult),
    );
  }).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      options.caller ?? threadCaller,
    ),
    Effect.provide(service),
  );
};

describe("user_insights_read", () => {
  it("takes an object input schema, as MCP clients require", () => {
    // An explicit empty Schema.Struct({}) serializes to `anyOf: [object, array]`,
    // and clients then reject the whole MCP server, not just this tool.
    for (const tool of Object.values(UserInsightsToolkit.tools)) {
      expect(Tool.getJsonSchema(tool).type).toBe("object");
    }
  });

  it.effect("returns only confident traits", () =>
    Effect.gen(function* () {
      const result = yield* read({ insights: snapshot({ state: "ready" }) });
      expect(result).toMatchObject({ state: "ready" });
      expect(
        result.traits.map((entry) => [entry.id, entry.confidence, entry.pinned] as const),
      ).toEqual([
        ["style.language", "high", false],
        ["style.tone", "medium", true],
      ]);
    }),
  );

  it.effect("says it is off, without traits, when insights are off", () =>
    Effect.gen(function* () {
      const result = yield* read({ insights: snapshot({ state: "off" }) });
      expect(result.state).toBe("off");
      expect(result.traits).toEqual([]);
    }),
  );

  it.effect("says it is off when the server has no user insights", () =>
    Effect.gen(function* () {
      const result = yield* read({ insights: null });
      expect(result.state).toBe("off");
    }),
  );

  it.effect("refuses callers outside a T3 thread", () =>
    Effect.gen(function* () {
      const error = yield* read({
        insights: snapshot({ state: "ready" }),
        caller: { ...threadCaller, thread: undefined },
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestratorMcpFailure");
    }),
  );
});
