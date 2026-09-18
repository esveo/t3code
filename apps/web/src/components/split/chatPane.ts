import { createContext, useContext } from "react";

import { useSplitThreadStore } from "../../splitThreadStore";
import { ROUTE_LEAF_ID } from "./splitLayout.logic";

/** The id of the pane a ChatView renders in. */
export const ChatPaneContext = createContext<string>(ROUTE_LEAF_ID);

/**
 * Whether the ChatView rendering this hook owns window-level input. Without a
 * split only the route pane exists, so it always does.
 */
export function useIsActiveChatPane(): boolean {
  const pane = useContext(ChatPaneContext);
  return useSplitThreadStore((state) =>
    state.layout.kind === "leaf" ? pane === ROUTE_LEAF_ID : state.activeLeafId === pane,
  );
}
