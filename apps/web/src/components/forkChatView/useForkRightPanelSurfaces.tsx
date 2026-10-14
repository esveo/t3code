import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useCallback, useMemo, type ReactNode } from "react";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { AgentStagePanel } from "../agentStage/AgentStagePanel";
import { useAgentStageEnabled } from "../agentStage/agentStageStore";
import { ForkNotesPanel } from "../forkNotes/ForkNotesPanel";
import { useForkNotesSurface } from "../forkNotes/useForkNotesSurface";
import { nextGitGraphPanelStep } from "../gitGraph/gitGraphPanelLadder";
import { ThreadInboxPanel } from "../threadInbox/ThreadInboxPanel";
import { useThreadInboxSurface } from "../threadInbox/useThreadInboxSurface";
import { ThreadOverviewPanel } from "../threadOrchestration/ThreadOverviewPanel";
import { useThreadOverviewSurface } from "../threadOrchestration/useThreadOverviewSurface";

const GitGraphView = lazy(() =>
  import("../gitGraph/GitGraphView").then((module) => ({ default: module.GitGraphView })),
);

/**
 * Fork: the right panel surfaces the fork adds to a chat — agent stage,
 * thread overview, inbox, notes and the Git graph. `ChatView` spreads
 * `tabProps` into its `RightPanelTabs` and asks `renderSurface` before its
 * own surfaces, so upstream's chain stays as it is.
 */
export function useForkRightPanelSurfaces(input: {
  threadRef: ScopedThreadRef | null;
  environmentId: EnvironmentId | undefined;
  workspaceRoot: string | undefined;
  projectTitle: string | undefined;
  composerDraftTarget: ComposerThreadTarget;
  isGitRepo: boolean;
  commitGraphSupported: boolean;
  rightPanel: {
    open: boolean;
    activeSurface: RightPanelSurface | null | undefined;
    canMaximize: boolean;
    maximized: boolean;
    toggleMaximized: () => void;
    closeSurface: (surface: RightPanelSurface) => void;
  };
}) {
  const { threadRef, rightPanel } = input;
  const agentStageEnabled = useAgentStageEnabled();
  const threadOverview = useThreadOverviewSurface(threadRef);
  const threadInbox = useThreadInboxSurface(threadRef);
  const notes = useForkNotesSurface(threadRef);
  const addAgentStageSurface = useCallback(() => {
    if (!threadRef || !agentStageEnabled) return;
    useRightPanelStore.getState().open(threadRef, "agent-stage");
  }, [threadRef, agentStageEnabled]);

  // The graph reads the repository the thread runs in: its worktree when it has
  // one, the project's workspace root otherwise. Older servers reject
  // `vcs.listCommitGraph` as unknown, so the surface stays unavailable rather
  // than opening a pane that can only fail.
  const gitGraphCwd = input.workspaceRoot ?? null;
  const gitGraphAvailable = input.isGitRepo && gitGraphCwd !== null && input.commitGraphSupported;
  const addGitGraphSurface = useCallback(() => {
    if (!threadRef || !gitGraphAvailable) return;
    useRightPanelStore.getState().open(threadRef, "git-graph");
  }, [threadRef, gitGraphAvailable]);
  /** The `gitGraph.open` shortcut: open, then maximize, then close. */
  const { activeSurface, canMaximize, maximized, toggleMaximized, closeSurface } = rightPanel;
  const panelOpen = rightPanel.open;
  const cycleGitGraphSurface = useCallback(() => {
    if (!threadRef) return;
    const showing = panelOpen && activeSurface?.kind === "git-graph";
    const step = nextGitGraphPanelStep({ showing, canMaximize, maximized });
    if (step === "open") {
      addGitGraphSurface();
      return;
    }
    if (step === "maximize") {
      toggleMaximized();
      return;
    }
    if (maximized) toggleMaximized();
    if (activeSurface) closeSurface(activeSurface);
  }, [
    activeSurface,
    addGitGraphSurface,
    canMaximize,
    closeSurface,
    maximized,
    panelOpen,
    threadRef,
    toggleMaximized,
  ]);

  const tabProps = useMemo(
    () => ({
      onAddGitGraph: addGitGraphSurface,
      onAddAgentStage: addAgentStageSurface,
      onAddThreadOverview: threadOverview.open,
      gitGraphAvailable,
      agentStageAvailable: agentStageEnabled,
      threadOverviewAvailable: threadOverview.available,
      threadsWaitingCount: threadOverview.waitingCount,
      threadInbox,
      notes,
    }),
    [
      addAgentStageSurface,
      addGitGraphSurface,
      agentStageEnabled,
      gitGraphAvailable,
      notes,
      threadInbox,
      threadOverview.available,
      threadOverview.open,
      threadOverview.waitingCount,
    ],
  );

  /** The panel for a fork surface, or undefined when the surface is upstream's. */
  const renderSurface = (surface: RightPanelSurface | null | undefined): ReactNode | undefined => {
    switch (surface?.kind) {
      case "agent-stage":
        return <AgentStagePanel threadRef={threadRef} workspaceRoot={input.workspaceRoot} />;
      case "thread-overview":
        return <ThreadOverviewPanel threadRef={threadRef} />;
      case "thread-inbox":
        return <ThreadInboxPanel threadRef={threadRef} cwd={input.workspaceRoot} />;
      case "notes":
        return (
          <ForkNotesPanel threadRef={threadRef} composerDraftTarget={input.composerDraftTarget} />
        );
      case "git-graph":
        if (gitGraphCwd === null || input.environmentId === undefined) return undefined;
        return (
          <Suspense fallback={null}>
            {/* No onClose: the surface tab's own X owns closing here. */}
            <GitGraphView
              key={`${input.environmentId}:${gitGraphCwd}`}
              mode="embedded"
              environmentId={input.environmentId}
              cwd={gitGraphCwd}
              title={input.projectTitle ?? gitGraphCwd}
            />
          </Suspense>
        );
      default:
        return undefined;
    }
  };

  return {
    tabProps,
    renderSurface,
    gitGraphAvailable,
    addGitGraphSurface,
    cycleGitGraphSurface,
  };
}
