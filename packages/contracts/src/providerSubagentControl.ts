/**
 * Fork: controls on a provider-native subagent's child thread. Only the parent
 * agent can reach its subagent, so a message to the subagent is a normal turn
 * on the parent thread asking it to pass the message on; `target` tells the
 * client what to address it to. `stop` ends the running subagent through its
 * provider, where the provider supports that.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

export const PROVIDER_SUBAGENT_CONTROL_WS_METHODS = {
  target: "providerSubagentControl.target",
  stop: "providerSubagentControl.stop",
} as const;

export const ProviderSubagentControlInput = Schema.Struct({
  /** The subagent's own (child) thread. */
  threadId: ThreadId,
});
export type ProviderSubagentControlInput = typeof ProviderSubagentControlInput.Type;

export const ProviderSubagentTarget = Schema.Struct({
  parentThreadId: ThreadId,
  /** The id the parent agent knows the subagent by (Claude: its task id). */
  agentId: Schema.String,
  title: Schema.NullOr(Schema.String),
  /** Whether the subagent's provider can stop a running subagent. */
  supportsStop: Schema.Boolean,
});
export type ProviderSubagentTarget = typeof ProviderSubagentTarget.Type;

export class ProviderSubagentControlError extends Schema.TaggedError<ProviderSubagentControlError>()(
  "ProviderSubagentControlError",
  { message: Schema.String },
) {}

export const WsProviderSubagentTargetRpc = Rpc.make(PROVIDER_SUBAGENT_CONTROL_WS_METHODS.target, {
  payload: ProviderSubagentControlInput,
  success: ProviderSubagentTarget,
  error: Schema.Union([ProviderSubagentControlError, EnvironmentAuthorizationError]),
});

export const WsProviderSubagentStopRpc = Rpc.make(PROVIDER_SUBAGENT_CONTROL_WS_METHODS.stop, {
  payload: ProviderSubagentControlInput,
  success: Schema.Struct({}),
  error: Schema.Union([ProviderSubagentControlError, EnvironmentAuthorizationError]),
});
