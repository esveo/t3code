import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { TerminalsToolkitHandlersLive } from "./handlers.ts";
import { TerminalsToolkit } from "./tools.ts";

/** Fork: registers the read-only terminal tools on the MCP server. */
export const TerminalsToolkitRegistrationLive = McpServer.toolkit(TerminalsToolkit).pipe(
  Layer.provide(TerminalsToolkitHandlersLive),
);
