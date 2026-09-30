/**
 * Fork: the Inbox tab of a coordinator. Its open decisions one at a time, with
 * arrows to page through them. Answers collect until "Send" hands them to the
 * coordinator together; anything beyond the options (an explanation, pros and
 * cons, an own answer) goes into the free-text box.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadDecision } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import { DecisionCard } from "./DecisionCard";
import {
  type DecisionDraft,
  describeSettled,
  draftToReply,
  hasDraft,
  isSnoozed,
  nextUndrafted,
  orderDecisions,
} from "@t3tools/shared/threadInbox";
import { threadInboxEnvironment } from "./threadInboxState";
import { useInboxDrafts, useInboxView, useThreadInboxStore } from "./threadInboxStore";
import { ChildRequestsSection } from "./ChildRequestsSection";
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
  const drafts = useInboxDrafts(key);
  const view = useInboxView(key);
  const setDraftInStore = useThreadInboxStore((state) => state.setDraft);
  const clearDrafts = useThreadInboxStore((state) => state.clearDrafts);
  const setViewInStore = useThreadInboxStore((state) => state.setView);
  const act = useAtomCommand(threadInboxEnvironment.act);
  const [showSettled, setShowSettled] = useState(false);
  const [sending, setSending] = useState(false);

  const decisions = surface.decisions;
  const ordered = useMemo(() => orderDecisions(decisions), [decisions]);
  const byId = useMemo(() => new Map(decisions.map((d) => [d.id, d])), [decisions]);
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
  // Answering pins the decision as current: otherwise a current one that only
  // fell back as "first unanswered" moves on at the first typed letter.
  const answer = useCallback(
    (decisionId: string, patch: Partial<DecisionDraft> | null) => {
      if (view.currentId !== decisionId) setView({ currentId: decisionId });
      setDraft(decisionId, patch);
    },
    [setDraft, setView, view.currentId],
  );
  const select = useCallback(
    (decision: ThreadDecision | null) => {
      if (!decision) return;
      setView({ currentId: decision.id });
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
  const goFollowing = useCallback(
    () => select(ordered[Math.min(ordered.length - 1, currentIndex + 1)] ?? null),
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
    const pressed = event.key;
    if (pressed === "j" || pressed === "ArrowDown" || pressed === "ArrowRight") {
      event.preventDefault();
      goFollowing();
    } else if (pressed === "k" || pressed === "ArrowUp" || pressed === "ArrowLeft") {
      event.preventDefault();
      goPrevious();
    } else if (current && /^[1-9]$/.test(pressed)) {
      const option = current.options[Number(pressed) - 1];
      if (option) answer(current.id, { optionId: option.id });
    } else if (current && (pressed === "y" || pressed === "Y")) {
      if (current.recommendedOptionId) {
        answer(current.id, { optionId: current.recommendedOptionId });
        goNext();
      }
    } else if (current && pressed === "e") {
      event.preventDefault();
      document
        .querySelector<HTMLTextAreaElement>(`textarea[data-inbox-note="${CSS.escape(current.id)}"]`)
        ?.focus();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {/* Fork: approvals and questions of the coordinator's threads. */}
          <ChildRequestsSection threadRef={threadRef} />

          {current ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground tabular-nums">
                  Decision {currentIndex + 1} of {ordered.length}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label="Previous decision"
                    onClick={goPrevious}
                    disabled={currentIndex <= 0}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label="Next decision"
                    onClick={goFollowing}
                    disabled={currentIndex >= ordered.length - 1}
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
              <DecisionCard
                key={current.id}
                decision={current}
                draft={drafts[current.id]}
                coordinatorRef={threadRef}
                cwd={cwd}
                dependencies={current.dependsOn.flatMap((id) => {
                  const dependency = byId.get(id);
                  return dependency ? [dependency] : [];
                })}
                onDraft={(patch) => answer(current.id, patch)}
              />
            </>
          ) : (
            <div className="px-1">
              <p className="text-base font-medium">Nothing is waiting on you</p>
              <p className="text-sm text-muted-foreground">
                The coordinator asks here instead of numbering questions in the chat.
              </p>
            </div>
          )}
          {surface.error ? (
            <p className="text-sm text-destructive-foreground">{surface.error}</p>
          ) : null}

          {settled.length > 0 ? (
            <section className="flex flex-col gap-0.5 border-t border-border pt-3">
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
                      ) : decision.status === "resolved" || decision.kind === "task" ? (
                        <Button size="xs" variant="ghost-muted" onClick={() => reopen(decision)}>
                          Reopen
                        </Button>
                      ) : null}
                    </div>
                  ))
                : null}
            </section>
          ) : null}
        </div>
      </ScrollArea>

      {ordered.length > 0 ? (
        <footer className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-3">
          <span className="flex-1 text-sm text-muted-foreground">
            {outbox.length > 0
              ? `${outbox.length} answer${outbox.length === 1 ? "" : "s"} ready`
              : "No answers yet"}
          </span>
          <Button
            size="sm"
            onClick={() => void send(outbox)}
            disabled={outbox.length === 0 || sending}
            title="Send (⌘⏎)"
          >
            Send {outbox.length > 0 ? outbox.length : ""}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
