import type { ScopedThreadRef } from "@t3tools/contracts";
import { useContext, useEffect, useMemo, useRef } from "react";

import { ChatPaneContext } from "../components/split/chatPane";
import { useThread } from "../state/entities";
import { AgentStage } from "./AgentStage";
import { deriveStageModel, MAIN_AGENT_ID } from "./agentStage.logic";
import { useAgentStageOpen, useAgentStageStore } from "./agentStageStore";

const EMPTY: ReadonlyArray<never> = [];

/**
 * Covers the chat column with the stage while the pane is in visual mode.
 * Mounted from ChatView with the thread it shows; everything else comes from
 * the thread store, so ChatView passes no state of its own.
 */
export function AgentStageOverlay({
  threadRef,
  workspaceRoot,
}: {
  threadRef: ScopedThreadRef | null;
  workspaceRoot?: string | null | undefined;
}) {
  const paneId = useContext(ChatPaneContext);
  const open = useAgentStageOpen(paneId);
  if (!open || threadRef === null) return null;
  return <OpenAgentStage paneId={paneId} threadRef={threadRef} workspaceRoot={workspaceRoot} />;
}

function OpenAgentStage({
  paneId,
  threadRef,
  workspaceRoot,
}: {
  paneId: string;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | null | undefined;
}) {
  const thread = useThread(threadRef);
  const activities = thread?.activities ?? EMPTY;
  const messages = thread?.messages ?? EMPTY;
  const session = thread?.session ?? null;
  const latestTurn = thread?.latestTurn ?? null;
  const model = useMemo(
    () =>
      deriveStageModel({
        activities,
        messages,
        session,
        latestTurn,
        workspaceRoot: workspaceRoot ?? undefined,
      }),
    [activities, latestTurn, messages, session, workspaceRoot],
  );
  const storedSelection = useAgentStageStore((state) => state.selectedByPane[paneId]);
  const selectedId = model.agents.some((agent) => agent.id === storedSelection)
    ? storedSelection!
    : MAIN_AGENT_ID;
  const select = useAgentStageStore((state) => state.select);
  const setOpen = useAgentStageStore((state) => state.setOpen);

  // Take focus so Escape closes the stage without a click first.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-agent-stage]")?.focus();
  }, []);

  return (
    <div ref={rootRef} className="contents">
      <AgentStage
        model={model}
        selectedId={selectedId}
        onSelect={(agentId) => select(paneId, agentId)}
        onClose={() => setOpen(paneId, false)}
      />
    </div>
  );
}
