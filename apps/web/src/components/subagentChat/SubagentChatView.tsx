/**
 * Fork: one subagent's conversation inside the Agents panel, drawn with the
 * main chat's own timeline and composer.
 *
 * The transcript streams from the server while this view is mounted, already
 * shaped as the main chat's messages and tool activities. What the parent sent
 * the subagent reads as user messages. Messages typed here go to the parent as
 * a normal turn asking it to relay them with SendMessage, since only the
 * parent can reach its subagents; they show up in the parent's chat as well.
 * The composer's stop button stops the subagent. Model, mode and context
 * controls are hidden: the subagent has none of its own to change.
 */
import { useAtomValue } from "@effect/atom-react";
import { type LegendListRef } from "@legendapp/list/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ServerProvider, ThreadId } from "@t3tools/contracts";
import { ChevronLeft } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { ChatComposer, type ChatComposerHandle } from "~/components/chat/ChatComposer";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { Button } from "~/components/ui/button";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  DraftId,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import { newMessageId } from "~/lib/utils";
import { deriveTimelineEntries, deriveWorkLogEntries } from "~/session-logic";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildSubagentRelayMessage, isLiveSubagent } from "./subagentChat.logic";
import { subagentChatEnvironment } from "./subagentChatState";

const noop = () => {};
const asyncNoop = async () => {};
const nullReason = () => null;
const EMPTY: never[] = [];
const EMPTY_RECORD = {};
const EMPTY_PROVIDERS: ServerProvider[] = [];

export function SubagentChatView({
  agent,
  environmentId,
  threadId,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onBack: () => void;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  const serverConfig = useServerConfigs().get(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { resolvedTheme } = useTheme();
  const transcript = useEnvironmentQuery(
    subagentChatEnvironment.transcript({
      environmentId,
      input: { threadId, agentId: agent.id },
    }),
  );
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const stop = useAtomCommand(subagentChatEnvironment.stop);
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const [sending, setSending] = useState(false);

  // Each subagent keeps its own draft, apart from the parent thread's.
  const draftTarget = useMemo(
    () => DraftId.make(`subagent:${threadId}:${agent.id}`),
    [agent.id, threadId],
  );
  const listRef = useRef<LegendListRef | null>(null);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);

  const messages = transcript.data?.messages;
  const activities = transcript.data?.activities;
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(messages ?? EMPTY, EMPTY, deriveWorkLogEntries(activities ?? EMPTY)),
    [activities, messages],
  );
  const live = isLiveSubagent(agent);
  const timelineKey = `subagent:${threadId}:${agent.id}`;

  const onSend = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      const text = promptRef.current.trim();
      if (text.length === 0 || thread === null || sending) return;
      setSending(true);
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildSubagentRelayMessage(agent, text),
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      setSending(false);
      if (result._tag === "Success") {
        promptRef.current = "";
        clearComposerContent(draftTarget);
      }
    },
    [agent, clearComposerContent, draftTarget, environmentId, sending, startTurn, thread, threadId],
  );
  const onStop = useCallback(() => {
    void stop({ environmentId, input: { threadId, agentId: agent.id } });
  }, [agent.id, environmentId, stop, threadId]);
  const focusComposer = useCallback(() => composerRef.current?.focusAtEnd(), []);

  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const emptyNotice = transcript.error
    ? transcript.error
    : transcript.data === null
      ? "Loading…"
      : !transcript.data.found
        ? live
          ? "Waiting for the transcript…"
          : "No transcript is available for this agent."
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <Button size="icon-sm" variant="ghost-muted" onClick={onBack} aria-label="Back to agents">
          <ChevronLeft aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{agent.title}</span>
          <span className="truncate font-mono text-[.65rem] text-muted-foreground">
            {[agent.role, modelLabel, live ? "working" : agent.status].filter(Boolean).join(" · ")}
          </span>
        </div>
      </header>
      {emptyNotice ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{emptyNotice}</p>
      ) : transcript.data?.truncated ? (
        <p className="px-3 py-1 text-center text-[.65rem] text-muted-foreground/70">
          Earlier messages are not shown.
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          isWorking={live}
          activeTurnStartedAt={live ? agent.startedAt : null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          runningTurnId={null}
          turnDiffSummaries={EMPTY}
          routeThreadKey={timelineKey}
          displayThreadKey={timelineKey}
          onOpenTurnDiff={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={thread?.worktreePath ?? undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat={settings.timestampFormat}
          workspaceRoot={thread?.worktreePath ?? undefined}
          anchorMessageId={null}
          onAnchorReady={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled
          onIsAtEndChange={noop}
          onManualNavigation={noop}
          hideEmptyPlaceholder
        />
      </div>
      <div className="px-2 pb-2">
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <ChatComposer
              hideThreadControls
              composerRef={composerRef}
              composerDraftTarget={draftTarget}
              environmentId={environmentId}
              attachmentUploadsCapabilityKnown
              supportsAttachmentUploads={false}
              supportsQuestionAttachments={false}
              maxFileAttachmentBytes={null}
              routeKind="server"
              routeThreadRef={threadRef}
              draftId={null}
              multipleModelSelections={null}
              supportsMultipleModels={false}
              onMultipleModelSelectionsChange={noop}
              activeThreadId={threadId}
              activeThreadEnvironmentId={environmentId}
              activeThread={undefined}
              activeThreadShell={null}
              promptHistoryMessages={EMPTY}
              isServerThread
              isLocalDraftThread={false}
              forceExpandedOnMobile={false}
              projectSelectionRequired={false}
              phase={live ? "running" : "ready"}
              isConnecting={false}
              isSendBusy={sending}
              sendDisabledReason={thread === null ? "Thread unavailable" : null}
              isPreparingWorktree={false}
              bannerItems={EMPTY}
              environmentUnavailable={null}
              activePendingApproval={null}
              pendingApprovals={EMPTY}
              pendingUserInputs={EMPTY}
              activePendingProgress={null}
              activePendingResolvedAnswers={null}
              activePendingIsResponding={false}
              activePendingDraftAnswers={EMPTY_RECORD}
              activePendingQuestionIndex={0}
              respondingRequestIds={EMPTY}
              showPlanFollowUpPrompt={false}
              activeProposedPlan={null}
              activeTasksProgress={null}
              activeTaskSteps={null}
              threadSyncPhase={null}
              runtimeMode={thread?.runtimeMode ?? "full-access"}
              interactionMode={thread?.interactionMode ?? "default"}
              lockedProvider={null}
              providerStatuses={(serverConfig?.providers ?? EMPTY_PROVIDERS) as ServerProvider[]}
              providerCatalogKnown={serverConfig !== undefined}
              activeProjectDefaultModelSelection={null}
              activeThreadModelSelection={thread?.modelSelection}
              activeContextWindow={null}
              compactThreadUnavailable
              compactDisabled
              compactDisabledReason={null}
              resolvedTheme={resolvedTheme}
              settings={settings}
              keybindings={keybindings}
              terminalOpen={false}
              gitCwd={thread?.worktreePath ?? null}
              pullRequestProjectId={null}
              pullRequestRepository={null}
              restingControlsHost={null}
              restingControlsHaveLeadingContext={false}
              onRestingControlsVisibilityChange={noop}
              getTimelineScrollableNode={() => null}
              isTimelineAtLogicalEnd={() => true}
              timelineOverflows={false}
              onComposerOverlayHeightChange={noop}
              onRestingChange={noop}
              promptRef={promptRef}
              composerImagesRef={composerImagesRef}
              composerFilesRef={composerFilesRef}
              composerTerminalContextsRef={composerTerminalContextsRef}
              onPageScrollKeyDown={noop}
              onPageScrollKeyUp={noop}
              onPageScrollRelease={noop}
              onCompactContext={noop}
              onSend={(event) => void onSend(event)}
              onInterrupt={onStop}
              onImplementPlanInNewThread={noop}
              onRespondToApproval={asyncNoop}
              onSelectActivePendingUserInputOption={noop}
              onAdvanceActivePendingUserInput={noop}
              onDismissActivePendingUserInput={noop}
              onPreviousActivePendingUserInputQuestion={noop}
              onChangeActivePendingUserInputCustomAnswer={noop}
              onProviderModelSelect={noop}
              onOpenProviderSetup={noop}
              getModelDisabledReason={nullReason}
              toggleInteractionMode={noop}
              handleRuntimeModeChange={noop}
              handleInteractionModeChange={noop}
              focusComposer={focusComposer}
              scheduleComposerFocus={focusComposer}
              setThreadError={noop}
              onExpandImage={noop}
              onFileOpen={noop}
            />
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}
