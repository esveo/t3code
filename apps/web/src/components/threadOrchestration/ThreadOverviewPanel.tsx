/**
 * Fork: the threads a coordinator started, grouped by what they need from the
 * user: what waits on them, what is running, what is ready for review, and
 * what is done. Each row opens its thread.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CHILD_THREAD_STATE_LABELS,
  childThreadProgress,
  describeChildThread,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";
import { ChevronDownIcon, LoaderCircleIcon, NetworkIcon } from "lucide-react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useMemo, useState } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { EmbeddedChildThread } from "./EmbeddedChildThread";
import {
  buildThreadOverview,
  childThreadsOf,
  type ThreadOverviewGroup,
  waitingThreadCount,
} from "./threadOverview.logic";
import { useOpenThread } from "./useOpenThread";

const STATE_TEXT_CLASS = {
  waiting: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive-foreground",
  working: "text-muted-foreground",
  review: "text-success-foreground",
  stopped: "text-muted-foreground",
  done: "text-muted-foreground",
} as const;

function OverviewRow({
  thread,
  onOpenInPanel,
}: {
  thread: EnvironmentThreadShell;
  onOpenInPanel: (threadRef: ScopedThreadRef) => void;
}) {
  const openThread = useOpenThread();
  const state = resolveChildThreadState(thread);
  const progress = childThreadProgress(thread);
  const age = formatElapsedDurationLabel(thread.updatedAt);
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
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{thread.title}</span>
        <span className="truncate text-xs">
          <span className={STATE_TEXT_CLASS[state]}>{CHILD_THREAD_STATE_LABELS[state]}</span>
          <span className="text-muted-foreground"> · {describeChildThread(thread)}</span>
        </span>
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {progress ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 px-1.5 py-0.5">
            <LoaderCircleIcon aria-hidden className="size-3" />
            {progress.completed}/{progress.total}
          </span>
        ) : null}
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
  onOpenInPanel,
}: {
  group: ThreadOverviewGroup;
  onOpenInPanel: (threadRef: ScopedThreadRef) => void;
}) {
  // Finished work folds away by default; everything else stays open.
  const [open, setOpen] = useState(group.id !== "done");
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
          {group.threads.length}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 py-1">
          {group.threads.map((thread) => (
            <OverviewRow key={thread.id} thread={thread} onOpenInPanel={onOpenInPanel} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ThreadOverviewPanel({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const threads = useThreadShells();
  const children = useMemo(
    () =>
      threadRef
        ? childThreadsOf(threads, {
            environmentId: threadRef.environmentId,
            id: threadRef.threadId,
          })
        : [],
    [threadRef, threads],
  );
  const groups = useMemo(() => buildThreadOverview(children), [children]);
  const waiting = waitingThreadCount(children);
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
            {waiting > 0
              ? `${waiting} thread${waiting === 1 ? " is" : "s are"} waiting on you`
              : "Nothing is waiting on you"}
          </p>
          <p className="text-xs text-muted-foreground">
            {children.length} thread{children.length === 1 ? "" : "s"} started from here
          </p>
        </header>
        {groups.map((group) => (
          <OverviewSection key={group.id} group={group} onOpenInPanel={openInPanel} />
        ))}
      </div>
    </ScrollArea>
  );
}
