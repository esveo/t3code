import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useContext } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { ChatPaneContext } from "./chatPane";
import { openThreadInPane } from "./splitPanes";

/**
 * Opens a thread from inside a chat view: in a split it stays in the pane the
 * click came from, otherwise it navigates like any thread link.
 */
export function useOpenThreadInPane(): (thread: ScopedThreadRef) => void {
  const pane = useContext(ChatPaneContext);
  const navigate = useNavigate();
  return useCallback(
    (thread) => {
      if (openThreadInPane(pane, thread)) return;
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(thread) });
    },
    [navigate, pane],
  );
}
