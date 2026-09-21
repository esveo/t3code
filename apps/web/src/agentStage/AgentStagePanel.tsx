import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThread } from "../state/entities";
import { AgentStage } from "./AgentStage";
import { deriveStageModel, MAIN_AGENT_ID } from "./agentStage.logic";
import { useAgentStageStore } from "./agentStageStore";

const EMPTY: ReadonlyArray<never> = [];

/**
 * The "Stage" surface of the right panel. Mounted from ChatView with the
 * thread it shows; everything else comes from the thread store, so ChatView
 * passes no state of its own.
 */
export function AgentStagePanel({
  threadRef,
  workspaceRoot,
}: {
  threadRef: ScopedThreadRef | null;
  workspaceRoot?: string | null | undefined;
}) {
  if (threadRef === null) return null;
  return <ThreadAgentStage threadRef={threadRef} workspaceRoot={workspaceRoot} />;
}

function ThreadAgentStage({
  threadRef,
  workspaceRoot,
}: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string | null | undefined;
}) {
  const threadKey = scopedThreadKey(threadRef);
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
  const storedSelection = useAgentStageStore((state) => state.selectedByThread[threadKey]);
  const selectedId = model.agents.some((agent) => agent.id === storedSelection)
    ? storedSelection!
    : MAIN_AGENT_ID;
  const showThoughts = useAgentStageStore((state) => state.showThoughts);
  const select = useAgentStageStore((state) => state.select);
  const setShowThoughts = useAgentStageStore((state) => state.setShowThoughts);

  return (
    <AgentStage
      model={model}
      selectedId={selectedId}
      showThoughts={showThoughts}
      onSelect={(agentId) => select(threadKey, agentId)}
      onToggleThoughts={setShowThoughts}
    />
  );
}
