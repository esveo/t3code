import { DesktopUpdateStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as ForkAppUpdates from "../../updates/ForkAppUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Private fork: restarts the t3 service on the pending fork server. */
export const restartForkService = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_SERVICE_RESTART_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.restartForkService")(function* () {
    const service = yield* Effect.serviceOption(ForkAppUpdates.ForkServiceUpdates);
    if (Option.isSome(service)) return yield* service.value.restart;
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});
