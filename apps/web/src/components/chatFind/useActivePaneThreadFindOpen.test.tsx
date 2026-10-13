import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSplitThreadStore } from "../../splitThreadStore";
import { requestThreadFindOpen } from "../chat/threadFindActionBus";
import { ChatPaneContext } from "../split/chatPane";
import { ROUTE_LEAF_ID, SINGLE_PANE_LAYOUT, type SplitNode } from "../split/splitLayout.logic";
import { useActivePaneThreadFindOpen } from "./useActivePaneThreadFindOpen";

const splitLayout: SplitNode = {
  kind: "split",
  id: "split-1",
  direction: "row",
  children: [
    { kind: "leaf", id: ROUTE_LEAF_ID, thread: "route" },
    {
      kind: "leaf",
      id: "pane-b",
      thread: { environmentId: "env-1" as EnvironmentId, threadId: "thread-b" as ThreadId },
    },
  ],
  sizes: [0.5, 0.5],
};

function Pane(props: { open: () => void }) {
  useActivePaneThreadFindOpen(props.open);
  return null;
}

describe("useActivePaneThreadFindOpen", () => {
  let renderer: ReactTestRenderer | null = null;
  const openRoute = vi.fn();
  const openB = vi.fn();
  const openEmbedded = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    openRoute.mockClear();
    openB.mockClear();
    openEmbedded.mockClear();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  function renderPanes() {
    act(() => {
      renderer = create(
        <>
          <ChatPaneContext.Provider value={ROUTE_LEAF_ID}>
            <Pane open={openRoute} />
          </ChatPaneContext.Provider>
          <ChatPaneContext.Provider value="pane-b">
            <Pane open={openB} />
          </ChatPaneContext.Provider>
          <ChatPaneContext.Provider value="embedded">
            <Pane open={openEmbedded} />
          </ChatPaneContext.Provider>
        </>,
      );
    });
  }

  it("opens find only in the active split pane", () => {
    useSplitThreadStore.setState({ layout: splitLayout, activeLeafId: "pane-b" });
    renderPanes();

    act(() => requestThreadFindOpen());

    expect(openB).toHaveBeenCalledTimes(1);
    expect(openRoute).not.toHaveBeenCalled();
    expect(openEmbedded).not.toHaveBeenCalled();
  });

  it("opens find in the route pane without a split", () => {
    useSplitThreadStore.setState({ layout: SINGLE_PANE_LAYOUT, activeLeafId: "pane-b" });
    renderPanes();

    act(() => requestThreadFindOpen());

    expect(openRoute).toHaveBeenCalledTimes(1);
    expect(openB).not.toHaveBeenCalled();
    expect(openEmbedded).not.toHaveBeenCalled();
  });
});
