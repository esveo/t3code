import { use, useEffect } from "react";

import { subscribeThreadFindOpen } from "../chat/threadFindActionBus";
import { activeChatPaneId, ChatPaneContext } from "../split/chatPane";

/**
 * Fork: upstream's find-open bus is window-wide, so with split panes every
 * chat view would open its bar. Only the pane that owns window-level input
 * answers; an embedded child thread's pane never does.
 */
export function useActivePaneThreadFindOpen(open: () => void): void {
  const paneId = use(ChatPaneContext);
  useEffect(
    () =>
      subscribeThreadFindOpen(() => {
        if (paneId === activeChatPaneId()) open();
      }),
    [open, paneId],
  );
}
