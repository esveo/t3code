import {
  FORK_NOTES_WS_METHODS,
  PROVIDER_SUBAGENT_CONTROL_WS_METHODS,
  THREAD_COORDINATORS_WS_METHODS,
  THREAD_DECISIONS_WS_METHODS,
  USER_INSIGHTS_WS_METHODS,
  VOICE_INPUT_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";

/** Fork: the `rpc.aggregate` labels of the fork's own WebSocket RPCs (`RpcInstrumentation.ts`). */
export const FORK_RPC_AGGREGATES = {
  [WS_METHODS.serverGetThreadUsage]: "server",
  [WS_METHODS.vcsListCommitGraph]: "vcs",
  [THREAD_DECISIONS_WS_METHODS.subscribe]: "orchestration",
  [THREAD_DECISIONS_WS_METHODS.act]: "orchestration",
  [FORK_NOTES_WS_METHODS.subscribe]: "server",
  [FORK_NOTES_WS_METHODS.act]: "server",
  [USER_INSIGHTS_WS_METHODS.read]: "server",
  [USER_INSIGHTS_WS_METHODS.act]: "server",
  [USER_INSIGHTS_WS_METHODS.suggest]: "server",
  [THREAD_COORDINATORS_WS_METHODS.subscribe]: "orchestration",
  [THREAD_COORDINATORS_WS_METHODS.set]: "orchestration",
  [VOICE_INPUT_WS_METHODS.prepare]: "server",
  [VOICE_INPUT_WS_METHODS.transcribe]: "server",
  [PROVIDER_SUBAGENT_CONTROL_WS_METHODS.target]: "orchestration",
  [PROVIDER_SUBAGENT_CONTROL_WS_METHODS.stop]: "orchestration",
} as const;
