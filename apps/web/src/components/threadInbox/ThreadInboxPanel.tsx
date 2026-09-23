/**
 * Fork: the Inbox tab of a coordinator. Its open decisions in one view with
 * two modes: a grouped list with one row open, and a focus mode that shows
 * the same decision large with the queue below. Both share the current
 * decision, and "Next" moves on to the next unanswered one in either. Replies
 * collect in the outbox and go to the coordinator together.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadDecision, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, InboxIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { useThreadShell, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOpenThread } from "../threadOrchestration/useOpenThread";
import { DecisionCard } from "./DecisionCard";
import {
  type DecisionDraft,
  describeDraft,
  describeSettled,
  draftToReply,
  groupDecisions,
  hasDraft,
  isSnoozed,
  nextUndrafted,
  orderDecisions,
  URGENCY_LABELS,
} from "./threadInbox.logic";
import { threadInboxEnvironment } from "./threadInboxState";
import { useInboxDrafts, useInboxView, useThreadInboxStore } from "./threadInboxStore";
import { useThreadInboxSurface } from "./useThreadInboxSurface";

const isTyping = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);

export function ThreadInboxPanel({
  threadRef,
  cwd,
}: {
  threadRef: ScopedThreadRef | null;
  cwd: string | undefined;
}) {
  if (!threadRef) return null;
  return <ThreadInbox threadRef={threadRef} cwd={cwd} />;
}

function ThreadInbox({ threadRef, cwd }: { threadRef: ScopedThreadRef; cwd: string | undefined }) {
  const key = scopedThreadKey(threadRef);
  const surface = useThreadInboxSurface(threadRef);
  const coordinator = useThreadShell(threadRef);
  const threads = useThreadShells();
  const drafts = useInboxDrafts(key);
  const view = useInboxView(key);
  const setDraftInStore = useThreadInboxStore((state) => state.setDraft);
  const clearDrafts = useThreadInboxStore((state) => state.clearDrafts);
  const setViewInStore = useThreadInboxStore((state) => state.setView);
  const act = useAtomCommand(threadInboxEnvironment.act);
  const openThread = useOpenThread();
  const [notesOpen, setNotesOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [showSettled, setShowSettled] = useState(false);
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  const [sending, setSending] = useState(false);

  const decisions = surface.decisions;
  const ordered = useMemo(() => orderDecisions(decisions), [decisions]);
  const byId = useMemo(() => new Map(decisions.map((d) => [d.id, d])), [decisions]);
  const threadTitle = useCallback(
    (threadId: ThreadId) =>
      threads.find(
        (thread) => thread.environmentId === threadRef.environmentId && thread.id === threadId,
      )?.title ?? null,
    [threadRef.environmentId, threads],
  );
  const groups = useMemo(
    () => groupDecisions(ordered, view.groupBy, threadTitle, coordinator?.title ?? "Coordinator"),
    [coordinator?.title, ordered, threadTitle, view.groupBy],
  );
  const settled = useMemo(
    () => decisions.filter((decision) => decision.status !== "open" || isSnoozed(decision)),
    [decisions],
  );
  const outbox = useMemo(
    () =>
      ordered.flatMap((decision) => {
        const draft = drafts[decision.id];
        return draft && hasDraft(draft) ? [{ decision, draft }] : [];
      }),
    [drafts, ordered],
  );

  // The current decision falls back to the first unanswered one once it is gone.
  const current =
    (view.currentId ? ordered.find((decision) => decision.id === view.currentId) : undefined) ??
    ordered.find((decision) => !hasDraft(drafts[decision.id])) ??
    ordered[0] ??
    null;
  const currentIndex = current ? ordered.indexOf(current) : -1;

  const setView = useCallback(
    (patch: Parameters<typeof setViewInStore>[1]) => setViewInStore(key, patch),
    [key, setViewInStore],
  );
  const setDraft = useCallback(
    (decisionId: string, patch: Partial<DecisionDraft> | null) =>
      setDraftInStore(key, decisionId, patch),
    [key, setDraftInStore],
  );
  const select = useCallback(
    (decision: ThreadDecision | null) => {
      if (!decision) return;
      setView({ currentId: decision.id, expanded: true });
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-inbox-row="${CSS.escape(decision.id)}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
    },
    [setView],
  );
  const goNext = useCallback(
    () => select(nextUndrafted(ordered, current?.id ?? null, drafts)),
    [current?.id, drafts, ordered, select],
  );
  const goPrevious = useCallback(
    () => select(ordered[Math.max(0, currentIndex - 1)] ?? null),
    [currentIndex, ordered, select],
  );

  const run = useCallback(
    async (input: Parameters<typeof act>[0]["input"], failureTitle: string): Promise<boolean> => {
      const result = await act({ environmentId: threadRef.environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      }
      return result._tag === "Success";
    },
    [act, threadRef.environmentId],
  );

  const send = useCallback(
    async (entries: ReadonlyArray<{ decision: ThreadDecision; draft: DecisionDraft }>) => {
      const replies = entries.flatMap(({ decision, draft }) => {
        const reply = draftToReply(decision.id, draft);
        return reply ? [reply] : [];
      });
      if (replies.length === 0 || sending) return;
      setSending(true);
      const sent = await run(
        { type: "submit", threadId: threadRef.threadId, replies },
        "Could not send the replies",
      );
      setSending(false);
      if (sent)
        clearDrafts(
          key,
          replies.map((reply) => reply.decisionId),
        );
    },
    [clearDrafts, key, run, sending, threadRef.threadId],
  );

  const snooze = useCallback(
    (decision: ThreadDecision, snoozed: boolean) =>
      void run(
        {
          type: snoozed ? "snooze" : "unsnooze",
          threadId: threadRef.threadId,
          decisionId: decision.id,
        },
        snoozed ? "Could not snooze" : "Could not unsnooze",
      ),
    [run, threadRef.threadId],
  );
  const reopen = useCallback(
    (decision: ThreadDecision) =>
      void run(
        { type: "reopen", threadId: threadRef.threadId, decisionId: decision.id },
        "Could not reopen",
      ),
    [run, threadRef.threadId],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send(outbox);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    const key = event.key;
    if (key === "j" || key === "ArrowDown") {
      event.preventDefault();
      select(ordered[Math.min(ordered.length - 1, currentIndex + 1)] ?? null);
    } else if (key === "k" || key === "ArrowUp") {
      event.preventDefault();
      goPrevious();
    } else if (key === "f") {
      setView({ mode: view.mode === "list" ? "focus" : "list", expanded: true });
    } else if (current && /^[1-9]$/.test(key)) {
      const option = current.options[Number(key) - 1];
      if (option) setDraft(current.id, { optionId: option.id });
    } else if (current && (key === "y" || key === "Y")) {
      if (current.recommendedOptionId) {
        setDraft(current.id, { optionId: current.recommendedOptionId });
        goNext();
      }
    } else if (current && key === "e") {
      event.preventDefault();
      setNotesOpen((open) => ({ ...open, [current.id]: true }));
      setView({ expanded: true });
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>(
            `textarea[data-inbox-note="${CSS.escape(current.id)}"]`,
          )
          ?.focus(),
      );
    }
  };

  const card = (decision: ThreadDecision, mode: "list" | "focus") => (
    <DecisionCard
      decision={decision}
      draft={drafts[decision.id]}
      mode={mode}
      coordinatorRef={threadRef}
      cwd={cwd}
      threadTitle={threadTitle}
      dependencies={decision.dependsOn.flatMap((id) => {
        const dependency = byId.get(id);
        return dependency ? [dependency] : [];
      })}
      noteOpen={notesOpen[decision.id] ?? false}
      onNoteOpenChange={(open) => setNotesOpen((notes) => ({ ...notes, [decision.id]: open }))}
      onDraft={(patch) => setDraft(decision.id, patch)}
      onSendNow={() => {
        const draft = drafts[decision.id];
        if (draft) void send([{ decision, draft }]);
      }}
      onSnooze={() => snooze(decision, true)}
      onOpenThread={(threadId) => openThread(scopeThreadRef(threadRef.environmentId, threadId))}
    />
  );

  const nav = (
    <div className="flex items-center justify-between gap-2 pt-1">
      <span className="text-xs text-muted-foreground tabular-nums">
        {currentIndex + 1} of {ordered.length}
      </span>
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost-muted" onClick={goPrevious} disabled={currentIndex <= 0}>
          Previous
        </Button>
        <Button size="xs" onClick={goNext} disabled={ordered.length < 2}>
          Next
        </Button>
      </div>
    </div>
  );

  const waiting = ordered.filter((decision) => !hasDraft(drafts[decision.id])).length;
  const sources = new Set(ordered.map((decision) => decision.sourceThreadId ?? "")).size;

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          <header className="px-1">
            <p className="text-base font-medium">
              {waiting > 0
                ? `${waiting} decision${waiting === 1 ? "" : "s"} waiting on you`
                : "Nothing is waiting on you"}
            </p>
            <p className="text-xs text-muted-foreground">
              {surface.error
                ? surface.error
                : ordered.length > 0
                  ? `${outbox.length} answered, not sent yet · from ${sources} thread${sources === 1 ? "" : "s"}`
                  : "The coordinator asks here instead of numbering questions in the chat."}
            </p>
          </header>

          {ordered.length > 0 ? (
            <div className="flex items-center justify-between gap-2 px-1">
              <ToggleGroup
                aria-label="Inbox view"
                variant="segmented"
                value={[view.mode]}
                onValueChange={(value) => {
                  const mode = value[0];
                  if (mode === "list" || mode === "focus") setView({ mode, expanded: true });
                }}
              >
                <Toggle value="list">List</Toggle>
                <Toggle value="focus">Focus</Toggle>
              </ToggleGroup>
              {view.mode === "list" ? (
                <ToggleGroup
                  aria-label="Group by"
                  variant="segmented"
                  value={[view.groupBy]}
                  onValueChange={(value) => {
                    const groupBy = value[0];
                    if (groupBy === "urgency" || groupBy === "thread") setView({ groupBy });
                  }}
                >
                  <Toggle value="urgency">Urgency</Toggle>
                  <Toggle value="thread">Thread</Toggle>
                </ToggleGroup>
              ) : null}
            </div>
          ) : null}

          {view.mode === "focus" && current ? (
            <>
              <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                <div className="flex gap-0.5" aria-hidden>
                  {ordered.map((decision) => (
                    <span
                      key={decision.id}
                      className={cn(
                        "h-0.5 flex-1 rounded-full",
                        hasDraft(drafts[decision.id]) ? "bg-primary" : "bg-border",
                        decision === current && "bg-foreground/60",
                      )}
                    />
                  ))}
                </div>
                {card(current, "focus")}
                {nav}
              </section>
              {ordered.length > 1 ? (
                <section className="flex flex-col gap-0.5">
                  <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Up next</p>
                  {ordered
                    .filter((decision) => decision !== current)
                    .map((decision) => (
                      <InboxRow
                        key={decision.id}
                        decision={decision}
                        draft={drafts[decision.id]}
                        subtitle={URGENCY_LABELS[decision.urgency]}
                        onClick={() => select(decision)}
                      />
                    ))}
                </section>
              ) : null}
            </>
          ) : (
            groups.map((group) => {
              const open =
                !collapsed[group.id] || group.decisions.some((decision) => decision === current);
              return (
                <section key={group.id}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setCollapsed((value) => ({ ...value, [group.id]: open }))}
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDownIcon
                      aria-hidden
                      className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
                    />
                    {group.label}
                    <span className="font-normal tabular-nums text-muted-foreground/80">
                      {group.decisions.length}
                    </span>
                  </button>
                  {open ? (
                    <div className="flex flex-col gap-0.5 py-1">
                      {group.decisions.map((decision) => {
                        const expanded = view.expanded && decision === current;
                        const source = decision.sourceThreadId
                          ? threadTitle(decision.sourceThreadId)
                          : null;
                        return (
                          <div
                            key={decision.id}
                            className={cn(expanded && "rounded-lg border border-border bg-card")}
                          >
                            <InboxRow
                              decision={decision}
                              draft={drafts[decision.id]}
                              expanded={expanded}
                              subtitle={
                                expanded
                                  ? [
                                      source ?? "Coordinator",
                                      URGENCY_LABELS[decision.urgency],
                                    ].join(" · ")
                                  : undefined
                              }
                              onClick={() =>
                                expanded ? setView({ expanded: false }) : select(decision)
                              }
                            />
                            {expanded ? (
                              <div className="flex flex-col gap-1 px-2.5 pb-2.5">
                                {card(decision, "list")}
                                {nav}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })
          )}

          {settled.length > 0 ? (
            <section className="flex flex-col gap-0.5">
              <Button
                size="xs"
                variant="ghost-muted"
                className="self-start"
                onClick={() => setShowSettled((value) => !value)}
              >
                {showSettled ? "Hide" : "Show"} {settled.length} done or snoozed
              </Button>
              {showSettled
                ? settled.map((decision) => (
                    <div
                      key={decision.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-1"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-muted-foreground">
                          {decision.title}
                        </span>
                        <span className="truncate text-xs text-muted-foreground/80">
                          {describeSettled(decision)}
                        </span>
                      </span>
                      {decision.status === "open" ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => snooze(decision, false)}
                        >
                          Unsnooze
                        </Button>
                      ) : decision.status === "resolved" ? (
                        <Button size="xs" variant="ghost-muted" onClick={() => reopen(decision)}>
                          Reopen
                        </Button>
                      ) : null}
                    </div>
                  ))
                : null}
            </section>
          ) : null}

          {ordered.length > 0 ? (
            <p className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
              <span>
                <Kbd>j</Kbd> <Kbd>k</Kbd> next/previous
              </span>
              <span>
                <Kbd>1</Kbd>–<Kbd>9</Kbd> option
              </span>
              <span>
                <Kbd>y</Kbd> recommended
              </span>
              <span>
                <Kbd>e</Kbd> note
              </span>
              <span>
                <Kbd>f</Kbd> list/focus
              </span>
            </p>
          ) : null}
        </div>
      </ScrollArea>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-2.5">
        {outbox.length > 0 ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Outbox · {outbox.length}</span>
              <span className="flex items-center gap-2">
                <Kbd>⌘⏎</Kbd>
                <Button size="xs" onClick={() => void send(outbox)} disabled={sending}>
                  Send all
                </Button>
              </span>
            </div>
            <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
              {outbox.map(({ decision, draft }) => (
                <span
                  key={decision.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-primary/30 bg-primary/10 py-0.5 pr-0.5 pl-2 text-xs"
                >
                  <span className="truncate">
                    <span className="font-medium">{decision.title}:</span>{" "}
                    {describeDraft(decision, draft)}
                  </span>
                  <Button
                    size="icon-tiny"
                    variant="ghost-muted"
                    aria-label={`Remove the reply to ${decision.title}`}
                    onClick={() => setDraft(decision.id, null)}
                  >
                    <XIcon />
                  </Button>
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <InboxIcon aria-hidden className="size-3.5" />
            Replies collect here and go to the coordinator together.
          </p>
        )}
      </footer>
    </div>
  );
}

function InboxRow({
  decision,
  draft,
  expanded,
  subtitle,
  onClick,
}: {
  decision: ThreadDecision;
  draft: DecisionDraft | undefined;
  expanded?: boolean;
  subtitle?: string | undefined;
  onClick: () => void;
}) {
  const drafted = hasDraft(draft);
  return (
    <button
      type="button"
      data-inbox-row={decision.id}
      aria-expanded={expanded}
      onClick={onClick}
      className="grid w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          drafted
            ? "bg-primary"
            : decision.urgency === "now"
              ? "bg-amber-500 dark:bg-amber-400"
              : decision.urgency === "today"
                ? "bg-blue-500 dark:bg-blue-400"
                : "bg-muted-foreground/50",
        )}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{decision.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {subtitle ?? (drafted && draft ? describeDraft(decision, draft) : decision.question)}
        </span>
      </span>
      {drafted ? <span className="text-xs text-primary">✓</span> : null}
    </button>
  );
}
