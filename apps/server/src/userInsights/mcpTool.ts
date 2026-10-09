/**
 * Fork: user insights. `user_insights_read` lets an agent T3 launched read
 * the confident part of what the server learned about how its user writes
 * and works. Read-only: it never starts a model call or changes the profile.
 * The service is read optionally, so the MCP layer gains no requirement.
 */
import {
  OrchestratorMcpFailure,
  type UserInsightsSnapshot,
  type UserInsightsStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { confidenceLevel } from "./profileMerge.ts";
import { UserInsights } from "./UserInsights.ts";

/** Traits below this confidence are guesses and stay out of agent context. */
export const MCP_MIN_CONFIDENCE = 0.5;

export const UserInsightsReadResult = Schema.Struct({
  state: Schema.Literals(["off", "learning", "ready", "paused"]),
  message: Schema.String,
  traits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      value: Schema.String,
      confidence: Schema.Literals(["medium", "high"]),
      pinned: Schema.Boolean.annotate({ description: "The user wrote or confirmed this value." }),
    }),
  ),
});
export type UserInsightsReadResult = typeof UserInsightsReadResult.Type;

const UserInsightsReadTool = Tool.make("user_insights_read", {
  description:
    "Read what this environment learned about how its user writes and works with coding agents: language, message style, stack, how they verify work and what they usually ask next. Only confident traits are returned. Use it to match the user's style; it is empty while user insights are off or still learning. Read-only.",
  success: UserInsightsReadResult,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Read user insights")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const UserInsightsToolkit = Toolkit.make(UserInsightsReadTool);

const OFF: UserInsightsReadResult = {
  state: "off",
  message: "User insights are off on this environment. The user can turn them on in Settings.",
  traits: [],
};

function statusMessage(status: UserInsightsStatus): string {
  switch (status.state) {
    case "off":
      return OFF.message;
    case "learning":
      return `Still learning (${status.samples} of ${status.requiredSamples} messages). Traits may be incomplete.`;
    case "ready":
      return "The profile is ready.";
    case "paused":
      return `Learning is paused (${status.reason}). The traits are the last ones learned.`;
  }
}

/** The confident traits of a snapshot, in the shape the tool returns. */
export function toReadResult(snapshot: UserInsightsSnapshot): UserInsightsReadResult {
  if (snapshot.status.state === "off") return OFF;
  return {
    state: snapshot.status.state,
    message: statusMessage(snapshot.status),
    traits: snapshot.traits.flatMap((trait) => {
      if (trait.confidence < MCP_MIN_CONFIDENCE) return [];
      const level = confidenceLevel(trait.confidence);
      return level === "low"
        ? []
        : [{ id: trait.id, value: trait.value, confidence: level, pinned: trait.pinned }];
    }),
  };
}

// The profile describes the person behind this environment, so only agents
// T3 launched in one of its threads read it, not outside MCP clients.
export const UserInsightsToolkitHandlersLive = McpToolAccess.toLayer(UserInsightsToolkit, {
  user_insights_read: McpToolAccess.readsAsCaller(() =>
    Effect.serviceOption(UserInsights).pipe(
      Effect.flatMap((insights) =>
        Option.isNone(insights)
          ? Effect.succeed(OFF)
          : insights.value.snapshot.pipe(
              Effect.map(toReadResult),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            ),
      ),
    ),
  ),
});
