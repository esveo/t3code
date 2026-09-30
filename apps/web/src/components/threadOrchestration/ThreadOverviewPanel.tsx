/**
 * Fork: the threads a coordinator started and the subagents its agent started,
 * grouped by what they need from the user: what waits on them, what is running,
 * what is ready for review, and what is done, split into still active and
 * settled. Each row opens its thread.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { CHILD_THREAD_STATE_LABELS } from "@t3tools/shared/threadOrchestration";
import {
  BotIcon,
  ChevronDownIcon,
  GitBranchIcon,
  MessageSquareIcon,
  NetworkIcon,
} from "lucide-react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useMemo, useState } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { EmbeddedChildThread } from "./EmbeddedChildThread";
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

function OverviewRow({
  entry,
  fallbackBranch,
  onOpenInPanel,
}: {
  entry: ThreadOverviewEntry;
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
  const provider = useProviderEntryLookup()(thread.environmentId, thread.modelSelection.instanceId);
  return (
    <button
      type="button"
      // Opens here, beside the coordinator; with Cmd/Ctrl as the thread itself.
      onClick={(event) => {
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        if (event.metaKey || event.ctrlKey) openThread(threadRef);
        else onOpenInPanel(threadRef);
      }}
      className="group/overview-row grid w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", CHILD_THREAD_DOT_CLASS[state])} />
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
            {entry.kind === "subagent" ? formatSubagentDisplayTitle(thread.title) : thread.title}
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
      <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {state === "review" ? (
          <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 text-success-foreground" />
        ) : null}
        {age ? <span className="min-w-8 text-right">{age}</span> : null}
      </span>
    </button>
  );
}

function OverviewSection({
  group,
  fallbackBranch,
  onOpenInPanel,
}: {
  group: ThreadOverviewGroup;
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
  const groups = useMemo(() => buildThreadOverview(children), [children]);
  const waiting = useMemo(() => waitingEntries(children), [children]);
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
            fallbackBranch={coordinatorBranch}
            onOpenInPanel={openInPanel}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
