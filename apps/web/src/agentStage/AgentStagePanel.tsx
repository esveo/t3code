import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useProject, useProjects, useThread, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { AgentStage } from "./AgentStage";
import { applyStageVisibility, deriveStageModel, MAIN_AGENT_ID } from "./agentStage.logic";
import { deriveFleetStageModel, type FleetThread } from "./agentStageFleet.logic";
import { AGENT_STAGE_EVERYTHING_KEY, useAgentStageStore } from "./agentStageStore";

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
  const threadTitle = thread?.title;
  const project = useProject(
    thread === null
      ? null
      : { environmentId: threadRef.environmentId, projectId: thread.projectId },
  );
  const threadModel = useMemo(
    () =>
      deriveStageModel({
        activities,
        messages,
        session,
        latestTurn,
        workspaceRoot: workspaceRoot ?? undefined,
        threadTitle,
        project,
      }),
    [activities, latestTurn, messages, project, session, threadTitle, workspaceRoot],
  );
  const mode = useAgentStageStore((state) => state.mode);
  const setMode = useAgentStageStore((state) => state.setMode);
  const everything = mode === "everything";
  const fleet = useFleetStageModel(everything, threadKey, threadModel);
  const fullModel = everything ? fleet.model : threadModel;

  // Hidden agents are filed per thread; the everything view has a key of its own.
  const visibilityKey = everything ? AGENT_STAGE_EVERYTHING_KEY : threadKey;
  const hiddenIds = useAgentStageStore((state) => state.hiddenByThread[visibilityKey]) ?? EMPTY;
  const { model, hidden } = useMemo(
    () => applyStageVisibility(fullModel, hiddenIds),
    [fullModel, hiddenIds],
  );
  const hide = useAgentStageStore((state) => state.hide);
  const show = useAgentStageStore((state) => state.show);
  const showAll = useAgentStageStore((state) => state.showAll);

  const storedSelection = useAgentStageStore((state) => state.selectedByThread[threadKey]);
  const selectedId = everything
    ? threadKey
    : model.agents.some((agent) => agent.id === storedSelection)
      ? storedSelection!
      : MAIN_AGENT_ID;
  const select = useAgentStageStore((state) => state.select);
  const navigate = useNavigate();
  const onSelect = useCallback(
    (agentId: string) => {
      if (everything) {
        // In the everything view a sprite is a thread: picking it opens it.
        const target = fleet.refs.get(agentId);
        if (target !== undefined && agentId !== threadKey) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        }
        return;
      }
      // Pointing at a hidden agent (from a request, say) brings it back.
      if (hiddenIds.includes(agentId)) show(threadKey, agentId);
      select(threadKey, agentId);
    },
    [everything, fleet.refs, hiddenIds, navigate, select, show, threadKey],
  );
  const approvals = useStageApprovals(threadRef);

  return (
    <AgentStage
      model={model}
      selectedId={selectedId}
      onSelect={onSelect}
      approvals={approvals}
      mode={mode}
      onModeChange={setMode}
      hidden={hidden}
      onHide={(agentId) => hide(visibilityKey, agentId)}
      onShow={(agentId) => show(visibilityKey, agentId)}
      onShowAll={() => showAll(visibilityKey)}
    />
  );
}

/**
 * Every thread with live work, from the shells the sidebar already holds.
 * Nothing is loaded for it: the fold runs only while the everything view is
 * open, and reruns when a shell changes.
 */
function useFleetStageModel(
  active: boolean,
  loadedKey: string,
  loadedModel: ReturnType<typeof deriveStageModel>,
) {
  const shells = useThreadShells();
  const projects = useProjects();
  return useMemo(() => {
    const refs = new Map<string, ScopedThreadRef>();
    if (!active) return { model: loadedModel, refs };
    const byId = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
    );
    const threads: FleetThread[] = shells.map((shell) => {
      const ref = { environmentId: shell.environmentId, threadId: shell.id };
      const key = scopedThreadKey(ref);
      refs.set(key, ref);
      return { key, shell, project: byId.get(`${shell.environmentId}:${shell.projectId}`) ?? null };
    });
    return {
      model: deriveFleetStageModel({ threads, loaded: { key: loadedKey, model: loadedModel } }),
      refs,
    };
  }, [active, loadedKey, loadedModel, projects, shells]);
}

/**
 * The stage answers approvals where it shows them, through the same command
 * the composer uses. Failures surface through the shared reporter; the stage
 * keeps no error state of its own.
 */
function useStageApprovals(threadRef: ScopedThreadRef) {
  const respond = useAtomCommand(threadEnvironment.respondToApproval);
  const [respondingRequestIds, setRespondingRequestIds] = useState<
    ReadonlyArray<ApprovalRequestId>
  >([]);
  const onRespondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    setRespondingRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    try {
      return await respond({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
    } finally {
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    }
  };
  return { respondingRequestIds, onRespondToApproval };
}
