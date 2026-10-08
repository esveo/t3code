import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ThreadId,
  UnifiedSettings,
  UserInsightsSuggestion,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useSyncExternalStore } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { useIsActiveChatPane } from "../split/chatPane";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  ENVIRONMENT_RETRY_MS,
  isEnvironmentWideSkip,
  SUGGESTION_DELAY_MS,
  suggestionEligibility,
} from "./suggestionEligibility";
import { UserInsightsSuggestionList } from "./UserInsightsSuggestionList";
import { userInsightsEnvironment } from "./userInsightsState";

/** The settings row of the suggestions toggle. */
const SETTINGS_ROW_ID = "user-insights-suggestions";
const MAX_ASKED_THREADS = 200;

/** The turn each thread was last asked about, across remounts and panes. */
const askedRunByThread = new Map<string, string>();
/** Until when an environment said no for every thread. */
const environmentWaitUntil = new Map<string, number>();

function rememberAsked(threadKey: string, runId: string) {
  askedRunByThread.delete(threadKey);
  askedRunByThread.set(threadKey, runId);
  if (askedRunByThread.size > MAX_ASKED_THREADS) {
    const oldest = askedRunByThread.keys().next().value;
    if (oldest !== undefined) askedRunByThread.delete(oldest);
  }
}

const selectSuggestionsEnabled = (settings: UnifiedSettings) =>
  settings.enableUserInsights && settings.enableUserInsightsSuggestions;

const promptIsEmpty = (target: ComposerThreadTarget) =>
  (useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "").trim().length === 0;

interface ShownSet {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly setId: string;
  readonly suggestions: ReadonlyArray<UserInsightsSuggestion>;
}

/**
 * The set on offer per thread, outside React so it survives remounts and a
 * thread switch while the call runs. Picking, dismissing or muting removes it.
 */
const shownSets = new Map<string, ShownSet>();
const shownListeners = new Set<() => void>();
function setShownSet(threadKey: string, set: ShownSet | null) {
  if (set === null) shownSets.delete(threadKey);
  else shownSets.set(threadKey, set);
  for (const listener of shownListeners) listener();
}
function subscribeShownSets(listener: () => void) {
  shownListeners.add(listener);
  return () => {
    shownListeners.delete(listener);
  };
}

/**
 * Fork: user insights. Appends the next-message suggestions to the composer's
 * notices once a turn finished in the active pane, and returns `items`
 * unchanged otherwise. Asks the server once per turn, 1.5 s after it ended,
 * only while the composer is empty and the window has focus.
 */
export function useUserInsightsBannerItems(input: {
  readonly items: ComposerBannerStackItem[];
  readonly environmentId: EnvironmentId;
  readonly threadShell: EnvironmentThreadShell | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  /** Approvals or questions waiting in the composer. */
  readonly hasPendingRequests: boolean;
  /** Called after a suggestion filled the composer, to focus it. */
  readonly onFilled?: () => void;
}): ComposerBannerStackItem[] {
  const { items, environmentId, threadShell: shell, hasPendingRequests } = input;
  const enabled = useEnvironmentSettings(environmentId, selectSuggestionsEnabled);
  const isActivePane = useIsActiveChatPane();
  const suggest = useAtomCommand(userInsightsEnvironment.suggest, { reportFailure: false });
  const act = useAtomCommand(userInsightsEnvironment.act, { reportFailure: false });
  const navigate = useNavigate();

  const { composerDraftTarget, onFilled } = input;
  const readPromptEmpty = useEffectEvent(() => promptIsEmpty(composerDraftTarget));

  const threadId = shell?.id ?? null;
  const threadKey = threadId === null ? null : `${environmentId}:${threadId}`;
  const shown = useSyncExternalStore(subscribeShownSets, () =>
    threadKey === null ? null : (shownSets.get(threadKey) ?? null),
  );
  const latestRunId = shell?.latestRun?.runId ?? null;
  const latestRunStatus = shell?.latestRun?.status ?? null;
  const runtimeActive = threadRuntimeIsActive(shell?.runtime);
  const isSubagent = shell?.lineage.relationshipToParent === "subagent";
  const hasPendingRuntimeRequest =
    shell !== null &&
    (shell.source.pendingRuntimeRequest !== null ||
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput);

  useEffect(() => {
    if (threadId === null || threadKey === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () =>
      suggestionEligibility({
        enabled,
        environmentWaiting: (environmentWaitUntil.get(environmentId) ?? 0) > Date.now(),
        isActivePane,
        documentVisible: document.visibilityState === "visible",
        documentFocused: document.hasFocus(),
        thread: {
          latestRun:
            latestRunId === null || latestRunStatus === null
              ? null
              : { runId: latestRunId, status: latestRunStatus },
          runtimeActive,
          isSubagent,
          hasPendingRuntimeRequest,
        },
        hasPendingRequests,
        promptEmpty: readPromptEmpty(),
        lastAskedRunId: askedRunByThread.get(threadKey) ?? null,
      });
    const ask = (runId: string) => {
      rememberAsked(threadKey, runId);
      void suggest({ environmentId, input: { threadId } }).then((result) => {
        if (result._tag !== "Success") return;
        const { setId, suggestions, skipped } = result.value;
        if (isEnvironmentWideSkip(skipped)) {
          environmentWaitUntil.set(environmentId, Date.now() + ENVIRONMENT_RETRY_MS);
        }
        if (setId !== null && suggestions.length > 0) {
          setShownSet(threadKey, { threadId, runId, setId, suggestions });
        }
      });
    };
    // Re-checked on focus too, so a turn that ended in the background is
    // asked about when the user comes back.
    const attempt = () => {
      if (timer !== null) return;
      const first = check();
      if (!first.eligible) return;
      timer = setTimeout(() => {
        timer = null;
        const again = check();
        if (again.eligible && again.runId === first.runId) ask(again.runId);
      }, SUGGESTION_DELAY_MS);
    };
    attempt();
    window.addEventListener("focus", attempt);
    document.addEventListener("visibilitychange", attempt);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", attempt);
      document.removeEventListener("visibilitychange", attempt);
    };
  }, [
    enabled,
    environmentId,
    hasPendingRequests,
    hasPendingRuntimeRequest,
    isActivePane,
    isSubagent,
    latestRunId,
    latestRunStatus,
    runtimeActive,
    suggest,
    threadId,
    threadKey,
  ]);

  const visible =
    shown !== null &&
    enabled &&
    shown.threadId === threadId &&
    shown.runId === latestRunId &&
    latestRunStatus === "completed" &&
    !runtimeActive &&
    !hasPendingRequests &&
    !hasPendingRuntimeRequest
      ? shown
      : null;
  const pick = useCallback(
    (index: number) => {
      const suggestion = visible?.suggestions[index];
      if (!visible || !suggestion) return;
      useComposerDraftStore.getState().setPrompt(composerDraftTarget, suggestion.prompt);
      if (threadKey !== null) setShownSet(threadKey, null);
      void act({
        environmentId,
        input: { type: "suggestion.fill", threadId: visible.threadId, setId: visible.setId, index },
      });
      onFilled?.();
    },
    [act, composerDraftTarget, environmentId, onFilled, threadKey, visible],
  );

  const dismiss = useCallback(() => {
    const current = visible;
    if (!current) return;
    if (threadKey !== null) setShownSet(threadKey, null);
    void act({
      environmentId,
      input: { type: "suggestion.dismiss", threadId: current.threadId, setId: current.setId },
    });
  }, [act, environmentId, threadKey, visible]);

  const mute = useCallback(() => {
    const current = visible;
    if (!current) return;
    if (threadKey !== null) setShownSet(threadKey, null);
    void act({ environmentId, input: { type: "thread.mute", threadId: current.threadId } });
  }, [act, environmentId, threadKey, visible]);

  const openSettings = useCallback(() => {
    void navigate({ to: "/settings/general", hash: SETTINGS_ROW_ID });
  }, [navigate]);

  const item = useMemo<ComposerBannerStackItem | null>(
    () =>
      visible === null
        ? null
        : {
            id: `user-insights:${visible.setId}`,
            variant: "info",
            priority: "notice",
            icon: <SparklesIcon />,
            title: (
              <span className="inline-flex items-center gap-1.5">
                Suggestions
                <Badge variant="outline" size="sm">
                  esveo
                </Badge>
              </span>
            ),
            children: (
              <UserInsightsSuggestionList suggestions={visible.suggestions} onPick={pick} />
            ),
            actions: (
              <>
                <Button size="xs" variant="ghost" onClick={mute}>
                  Not for this thread
                </Button>
                <Button size="xs" variant="ghost" onClick={openSettings}>
                  Turn off
                </Button>
              </>
            ),
            dismissLabel: "Dismiss suggestions",
            onDismiss: dismiss,
          },
    [dismiss, mute, openSettings, pick, visible],
  );

  return useMemo(() => (item === null ? items : [...items, item]), [item, items]);
}
