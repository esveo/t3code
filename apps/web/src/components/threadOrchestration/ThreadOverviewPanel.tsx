/**
 * Fork: the threads a coordinator started and the subagents its agent started,
 * grouped by what they need from the user: what waits on them, what is running,
 * what is ready for review, and what is done, split into still active and
 * settled. Each row opens its thread; right-click shows the sidebar's thread menu.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { CHILD_THREAD_STATE_LABELS } from "@t3tools/shared/threadOrchestration";
import {
  BotIcon,
  ChevronDownIcon,
  GitBranchIcon,
  MessageSquareIcon,
  NetworkIcon,
} from "lucide-react";

import { canShareWithGuestAtom } from "~/components/chat/guestShareAvailability";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useProject, useThreadShell } from "~/state/entities";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { EmbeddedChildThread } from "./EmbeddedChildThread";
import { useThreadParentActions } from "./ThreadParentActions";
import {
  buildThreadOverview,
  countOverviewEntries,
  describeOverviewOrigin,
  type ThreadOverviewEntry,
  type ThreadOverviewGroup,
  waitingEntries,
} from "./threadOverview.logic";
import { useOpenThread } from "./useOpenThread";
import { useProviderEntryLookup } from "./useProviderEntryLookup";
import { useThreadOverviewEntries } from "./useThreadOverviewEntries";

const KIND_VISUALS = {
  thread: { icon: MessageSquareIcon, label: "Thread" },
  subagent: { icon: BotIcon, label: "Subagent" },
} as const;

/** The pull request a row links to: the thread's newest open one. */
function newestOpenPullRequest(links: ReadonlyArray<ThreadPullRequestLink>) {
  return links.findLast((link) => link.snapshot === null || link.snapshot.state === "open") ?? null;
}

function OverviewRow({
  entry,
  coordinatorRef,
  fallbackBranch,
  onOpenInPanel,
}: {
  entry: ThreadOverviewEntry;
  /** The coordinator whose side panel shows this overview, and so the pull request too. */
  coordinatorRef: ScopedThreadRef | null;
  /** The coordinator's branch, where a subagent without a branch of its own works. */
  fallbackBranch: string | null;
  onOpenInPanel: (threadRef: ScopedThreadRef) => void;
}) {
  const openThread = useOpenThread();
  const { thread, state } = entry;
  const kind = KIND_VISUALS[entry.kind];
  const age = formatElapsedDurationLabel(entry.updatedAt);
  // State shows in the dot and the section; the line below says where and with what it works.
  const branch = thread.branch ?? fallbackBranch;
  const model = formatModelSlugName(thread.modelSelection.model);
  const openPrLink = useOpenPrLink();
  const pullRequest = newestOpenPullRequest(thread.pullRequests ?? []);
  const provider = useProviderEntryLookup()(thread.environmentId, thread.modelSelection.instanceId);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const [renaming, setRenaming] = useState(false);
  const renameCancelledRef = useRef(false);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const commitRename = (value: string) => {
    setRenaming(false);
    const title = value.trim();
    if (title.length === 0) {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (title === thread.title) return;
    void updateThreadMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd:
      useProject(scopeProjectRef(thread.environmentId, thread.projectId))?.workspaceRoot ?? null,
    onStartRename: () => {
      if (readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
        renameCancelledRef.current = false;
        setRenaming(true);
      }
    },
    canShareWithGuest: useAtomValue(canShareWithGuestAtom(thread.environmentId)),
    forkParentActions: useThreadParentActions(),
  });
  return (
    <div
      className="group/overview-row grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md transition-colors hover:bg-accent/60"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {renaming ? (
        <div className="py-1 pl-2">
          <input
            autoFocus
            aria-label="Thread title"
            defaultValue={thread.title}
            onFocus={(event) => event.currentTarget.select()}
            // Unmounting the focused input on Escape can still fire blur.
            onBlur={(event) => {
              if (!renameCancelledRef.current) commitRename(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                renameCancelledRef.current = true;
                setRenaming(false);
              }
            }}
            className="w-full rounded-sm border border-input bg-background px-1.5 py-0.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        </div>
      ) : (
        <button
          type="button"
          // Opens here, beside the coordinator; with Cmd/Ctrl as the thread itself.
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) openThread(threadRef);
            else onOpenInPanel(threadRef);
          }}
          className="grid w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)] items-center gap-x-2.5 rounded-md py-1.5 pl-2 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", CHILD_THREAD_DOT_CLASS[state])}
          />
          <span className="sr-only">{CHILD_THREAD_STATE_LABELS[state]}: </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                  <kind.icon aria-hidden className="size-3.5 text-muted-foreground/70" />
                  <span className="sr-only">{kind.label}: </span>
                </TooltipTrigger>
                <TooltipPopup side="top">{kind.label}</TooltipPopup>
              </Tooltip>
              <span className="truncate text-sm font-medium">
                {entry.kind === "subagent"
                  ? formatSubagentDisplayTitle(thread.title)
                  : thread.title}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {provider ? (
                <ProviderInstanceIcon
                  driverKind={provider.driverKind}
                  displayName={provider.displayName}
                  acpRegistryAgentId={provider.acpRegistryAgentId}
                  acpRegistryIconUrl={provider.acpRegistryIconUrl}
                  iconClassName="size-3 shrink-0"
                />
              ) : null}
              {model ? <span className="shrink-0">{model}</span> : null}
              {branch ? (
                <>
                  {model ? <span aria-hidden>·</span> : null}
                  <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{branch}</span>
                </>
              ) : null}
            </span>
          </span>
        </button>
      )}
      <span className="flex items-center gap-2 pr-2 pl-2.5 text-xs text-muted-foreground tabular-nums">
        {pullRequest ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Open pull request #${pullRequest.number}`}
            title="Open the pull request (Cmd/Ctrl-click: in the browser)"
            onClick={(event) =>
              openPrLink(
                event,
                pullRequest.url,
                coordinatorRef ?? scopeThreadRef(thread.environmentId, thread.id),
              )
            }
          >
            <PullRequestGlyph.pullRequest aria-hidden className="text-success-foreground" />#
            {pullRequest.number}
          </Button>
        ) : null}
        {age ? <span className="min-w-8 text-right">{age}</span> : null}
      </span>
    </div>
  );
}

function OverviewSection({
  group,
  coordinatorRef,
  fallbackBranch,
  onOpenInPanel,
}: {
  group: ThreadOverviewGroup;
  coordinatorRef: ScopedThreadRef | null;
  fallbackBranch: string | null;
  onOpenInPanel: (threadRef: ScopedThreadRef) => void;
}) {
  // Finished work folds away by default; everything else stays open.
  const [open, setOpen] = useState(group.id !== "settled");
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
        />
        {group.label}
        <span className="font-normal tabular-nums text-muted-foreground/80">
          {group.entries.length}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 py-1">
          {group.entries.map((entry) => (
            <OverviewRow
              key={entry.thread.id}
              entry={entry}
              coordinatorRef={coordinatorRef}
              fallbackBranch={fallbackBranch}
              onOpenInPanel={onOpenInPanel}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ThreadOverviewPanel({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const children = useThreadOverviewEntries(threadRef);
  const coordinatorBranch = useThreadShell(threadRef)?.branch ?? null;
  const groups = buildThreadOverview(children);
  const waiting = waitingEntries(children);
  // The child open in the panel, cleared when the panel moves to another coordinator.
  const [openChild, setOpenChild] = useState<{
    readonly coordinatorKey: string;
    readonly threadRef: ScopedThreadRef;
  } | null>(null);
  const coordinatorKey = threadRef ? scopedThreadKey(threadRef) : null;
  const openChildRef = openChild?.coordinatorKey === coordinatorKey ? openChild.threadRef : null;

  if (openChildRef && coordinatorKey) {
    return (
      <EmbeddedChildThread
        key={scopedThreadKey(openChildRef)}
        threadRef={openChildRef}
        onBack={() => setOpenChild(null)}
      />
    );
  }
  const openInPanel = (childRef: ScopedThreadRef) =>
    coordinatorKey ? setOpenChild({ coordinatorKey, threadRef: childRef }) : undefined;

  if (children.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <NetworkIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No threads yet</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          Ask the agent to split the work into threads. Each one works on its own branch, and the
          ones that need you show up here first.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-3 p-3">
        <header className="px-1">
          <p className="text-base font-medium">
            {waiting.length > 0
              ? `${countOverviewEntries(waiting)} ${waiting.length === 1 ? "is" : "are"} waiting on you`
              : "Nothing is waiting on you"}
          </p>
          <p className="text-xs text-muted-foreground">{describeOverviewOrigin(children)}</p>
        </header>
        {groups.map((group) => (
          <OverviewSection
            key={group.id}
            group={group}
            coordinatorRef={threadRef}
            fallbackBranch={coordinatorBranch}
            onOpenInPanel={openInPanel}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
