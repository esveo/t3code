import * as RpcGroup from "effect/rpc/RpcGroup";

import { AGENT_TIME_WS_METHODS, WsAgentTimeSummaryRpc } from "./agentTime.ts";
import { FORK_NOTES_WS_METHODS, WsForkNotesActRpc, WsForkNotesSubscribeRpc } from "./forkNotes.ts";
import {
  PROVIDER_SUBAGENT_CONTROL_WS_METHODS,
  WsProviderSubagentStopRpc,
  WsProviderSubagentTargetRpc,
} from "./providerSubagentControl.ts";
import {
  THREAD_COORDINATORS_WS_METHODS,
  WsThreadCoordinatorsSetRpc,
  WsThreadCoordinatorsSubscribeRpc,
} from "./threadCoordinators.ts";
import {
  THREAD_DECISIONS_WS_METHODS,
  WsThreadDecisionsActRpc,
  WsThreadDecisionsSubscribeRpc,
} from "./threadDecisions.ts";
import {
  VOICE_INPUT_WS_METHODS,
  WsVoiceInputPrepareRpc,
  WsVoiceInputTranscribeRpc,
} from "./voiceInput.ts";

/**
 * Fork: esveo code's own WebSocket methods. `WsRpcGroup` merges them in, so
 * clients see one group. The server builds their handlers as a group of their
 * own: one handler map over every method is more than TypeScript can type.
 */
export const ForkWsRpcGroup = RpcGroup.make(
  // Decisions a coordinator asks the user for.
  WsThreadDecisionsSubscribeRpc,
  WsThreadDecisionsActRpc,
  // Notes and todos in the Notes tab.
  WsForkNotesSubscribeRpc,
  WsForkNotesActRpc,
  // Which coordinator a thread reports to.
  WsThreadCoordinatorsSubscribeRpc,
  WsThreadCoordinatorsSetRpc,
  // Dictation in the composer.
  WsVoiceInputPrepareRpc,
  WsVoiceInputTranscribeRpc,
  // Stop and message a provider subagent from its thread.
  WsProviderSubagentTargetRpc,
  WsProviderSubagentStopRpc,
  // Where agents spend their time (Usage page).
  WsAgentTimeSummaryRpc,
);

/** The methods of `ForkWsRpcGroup`, for leaving them out of upstream's handler map. */
export const FORK_WS_RPC_TAGS = [
  THREAD_DECISIONS_WS_METHODS.subscribe,
  THREAD_DECISIONS_WS_METHODS.act,
  FORK_NOTES_WS_METHODS.subscribe,
  FORK_NOTES_WS_METHODS.act,
  THREAD_COORDINATORS_WS_METHODS.subscribe,
  THREAD_COORDINATORS_WS_METHODS.set,
  VOICE_INPUT_WS_METHODS.prepare,
  VOICE_INPUT_WS_METHODS.transcribe,
  PROVIDER_SUBAGENT_CONTROL_WS_METHODS.target,
  PROVIDER_SUBAGENT_CONTROL_WS_METHODS.stop,
  AGENT_TIME_WS_METHODS.summary,
] as const;
