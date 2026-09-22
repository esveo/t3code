// Private fork: install or delete one branch's prepared build. See
// ../../updates/ForkAppUpdates.ts.
import { DesktopForkBuildActionSchema, DesktopUpdateActionResultSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ForkAppUpdates from "../../updates/ForkAppUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const forkBuildAction = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_BUILD_ACTION_CHANNEL,
  payload: DesktopForkBuildActionSchema,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.forkBuildAction")(function* (action) {
    const builds = yield* ForkAppUpdates.ForkAppBuilds;
    return yield* builds.act(action);
  }),
});
