import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import {
  useProject,
  useProjects,
  useThreadProjection,
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentStage, type StageOpenAction } from "./AgentStage";
import {
  applyStageVisibility,
  deriveStageModel,
  MAIN_AGENT_ID,
  stageSubagents,
  type StageAgent,
} from "./agentStage.logic";
import { deriveFleetStageModel, type FleetThread } from "./agentStageFleet.logic";
import { AGENT_STAGE_EVERYTHING_KEY, useAgentStageStore } from "./agentStageStore";
import { useStageSubagentThreads } from "./useStageSubagentThreads";

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
  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const threadTitle = shell?.title;
  const pendingBackgroundTasks = shell?.pendingBackgroundTasks ?? EMPTY;
  const project = useProject(
    shell === null ? null : { environmentId: threadRef.environmentId, projectId: shell.projectId },
  );
  const mode = useAgentStageStore((state) => state.mode);
  const setMode = useAgentStageStore((state) => state.setMode);
  const everything = mode === "everything";
  // Hidden agents are filed per thread; the everything view has a key of its own.
  const visibilityKey = everything ? AGENT_STAGE_EVERYTHING_KEY : threadKey;
  const hiddenIds = useAgentStageStore((state) => state.hiddenByThread[visibilityKey]) ?? EMPTY;

  // Only the thread view draws subagents, and only the ones not hidden are followed.
  const followedThreadIds = useMemo(
    () =>
      everything
        ? EMPTY
        : stageSubagents(projection).flatMap((agent) =>
            agent.childThreadId === null || hiddenIds.includes(agent.id)
              ? []
              : [agent.childThreadId],
          ),
    [everything, hiddenIds, projection],
  );
  const subagentThreads = useStageSubagentThreads(threadRef.environmentId, followedThreadIds);
  const threadModel = useMemo(
    () =>
      deriveStageModel({
        projection,
        subagentThreads,
        pendingBackgroundTasks,
        workspaceRoot: workspaceRoot ?? undefined,
        threadTitle,
        project,
      }),
    [pendingBackgroundTasks, project, projection, subagentThreads, threadTitle, workspaceRoot],
  );
  const fleet = useFleetStageModel(everything, threadKey, threadModel);
  const fullModel = everything ? fleet.model : threadModel;

  const { model, hidden } = useMemo(
    () => applyStageVisibility(fullModel, hiddenIds),
    [fullModel, hiddenIds],
  );
  const hide = useAgentStageStore((state) => state.hide);
  const show = useAgentStageStore((state) => state.show);
  const showAll = useAgentStageStore((state) => state.showAll);

  // The everything view keeps its pick under its own key, like its hidden threads.
  const storedSelection = useAgentStageStore((state) => state.selectedByThread[visibilityKey]);
  const selectedId = model.agents.some((agent) => agent.id === storedSelection)
    ? storedSelection!
    : everything
      ? threadKey
      : MAIN_AGENT_ID;
  const select = useAgentStageStore((state) => state.select);
  const onSelect = useCallback(
    (agentId: string) => {
      // Pointing at a hidden agent (from a request, say) brings it back.
      if (hiddenIds.includes(agentId)) show(visibilityKey, agentId);
      select(visibilityKey, agentId);
    },
    [hiddenIds, select, show, visibilityKey],
  );
  const openAction = useStageOpenAction(threadRef, everything, fleet.refs);
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
      openAction={openAction}
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
 * Where the selected agent can be talked to. A thread sprite opens its
 * thread, a subagent its own thread. The open thread's own main agent needs
 * no button: its chat is right there.
 */
function useStageOpenAction(
  threadRef: ScopedThreadRef,
  everything: boolean,
  refs: ReadonlyMap<string, ScopedThreadRef>,
) {
  const navigate = useNavigate();
  const threadKey = scopedThreadKey(threadRef);
  return useCallback(
    (agent: StageAgent): StageOpenAction | null => {
      if (everything) {
        const target = refs.get(agent.id);
        if (target === undefined || agent.id === threadKey) return null;
        return {
          label: "Open thread",
          onOpen: () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(target),
            }),
        };
      }
      const childThreadId = agent.childThreadId ?? null;
      if (childThreadId === null) return null;
      return {
        label: "Open chat",
        onOpen: () =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({
              environmentId: threadRef.environmentId,
              threadId: childThreadId,
            }),
          }),
      };
    },
    [everything, navigate, refs, threadKey, threadRef.environmentId],
  );
}

/**
 * The stage answers approvals where it shows them, through the same command
 * the composer uses. Failures surface through the shared reporter; the stage
 * keeps no error state of its own.
 */
function useStageApprovals(threadRef: ScopedThreadRef) {
  const respond = useAtomCommand(threadEnvironment.respondToApproval);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ReadonlyArray<RuntimeRequestId>>(
    [],
  );
  const onRespondToApproval = async (
    requestId: RuntimeRequestId,
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
