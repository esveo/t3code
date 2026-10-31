import * as Effect from "effect/Effect";

import { voiceSayResultMessage } from "../../../voiceCall/voiceCallPrompt.ts";
import { VoiceCallService } from "../../../voiceCall/VoiceCallService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { VoiceCallToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(VoiceCallToolkit, {
  voice_say: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "voice_say");
      const voice = yield* VoiceCallService;
      const status = yield* voice.say(thread.threadId, input.text);
      return { status, message: voiceSayResultMessage[status] };
    }),
  ),
});
