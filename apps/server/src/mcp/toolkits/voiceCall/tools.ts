/** Fork: lets the agent of the thread on a voice call talk to the user while it works. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { VoiceCallService } from "../../../voiceCall/VoiceCallService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { areVoiceCallToolsOn } from "../../McpOrchestrationTools.ts";

const VoiceSayTool = Tool.make("voice_say", {
  description:
    "Only during a voice call on this thread: say one or two spoken sentences to the user. Returns once they were said, or when the user interrupts.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  }),
  success: Schema.Struct({
    status: Schema.Literals(["spoken", "interrupted", "call_ended", "no_call", "timed_out"]),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    VoiceCallService,
  ],
})
  .annotate(Tool.Title, "Say in voice call")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, areVoiceCallToolsOn);

export const VoiceCallToolkit = Toolkit.make(VoiceSayTool);
