import { SUBAGENT_CHAT_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "~/connection/runtime";
import { applySubagentTranscriptChunk, EMPTY_SUBAGENT_TRANSCRIPT } from "./subagentChat.logic";

export const subagentChatEnvironment = {
  /**
   * The open view's transcript, accumulated from the server's chunks. Held
   * only while the view is mounted plus a short grace, so a closed view stops
   * the server's tail.
   */
  transcript: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:subagent-chat:transcript",
    tag: SUBAGENT_CHAT_WS_METHODS.subscribeTranscript,
    idleTtlMs: 10_000,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(EMPTY_SUBAGENT_TRANSCRIPT, applySubagentTranscriptChunk),
        // scan opens with its seed; the view waits for the server's first chunk instead.
        Stream.drop(1),
      ),
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:subagent-chat:stop",
    tag: SUBAGENT_CHAT_WS_METHODS.stop,
  }),
};
