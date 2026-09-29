import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  CHILD_THREAD_STATE_LABELS,
  FROM_COORDINATOR_TAG,
  parseTaggedThreadMessage,
  parseThreadUpdates,
  type TaggedThreadMessage as ParsedTaggedThreadMessage,
} from "@t3tools/shared/threadOrchestration";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";
import { useChildAnswerCwd, useIsLatestThreadUpdate } from "./childAnswer";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { ThreadLinkChip } from "./ThreadLinkChip";

interface TaggedRow {
  readonly message: { readonly id?: string; readonly text: string };
}

/**
 * Fork: messages between a coordinator and its threads. A child's update to
 * its coordinator reads as a card with the child's chip, state and answer
 * (open while it is the coordinator's newest message); a
 * coordinator's message to a child stays a user message, labeled with who
 * sent it. Everything else renders as the timeline always does.
 */
export function TaggedThreadMessage<Row extends TaggedRow>(props: {
  row: Row;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  renderUserRow: (row: Row) => ReactNode;
}) {
  const tagged = useMemo(
    () => parseTaggedThreadMessage(props.row.message.text),
    [props.row.message.text],
  );
  const bodyRow = useMemo(
    () =>
      tagged
        ? ({
            ...props.row,
            message: {
              ...props.row.message,
              text: tagged.body,
              // "From <coordinator>" names the sender; upstream's "Sent by another agent" would repeat it.
              ...(tagged.tag === FROM_COORDINATOR_TAG ? { createdBy: "user" } : {}),
            },
          } as Row)
        : props.row,
    [props.row, tagged],
  );
  const bundle = useMemo(
    () => (tagged ? null : parseThreadUpdates(props.row.message.text)),
    [props.row.message.text, tagged],
  );
  const isLatest = useIsLatestThreadUpdate(props.threadRef, props.row.message.id);
  if (bundle) {
    // Updates of several children that arrived together as one turn.
    return (
      <div className="flex flex-col gap-1.5">
        {bundle.map((update) => (
          <ThreadUpdateCard
            key={`${update.threadId}:${update.state ?? ""}`}
            update={update}
            environmentId={props.environmentId}
            threadRef={props.threadRef}
            markdownCwd={props.markdownCwd}
            isLatest={isLatest}
          />
        ))}
      </div>
    );
  }
  if (!tagged) return props.renderUserRow(props.row);
  if (tagged.tag === FROM_COORDINATOR_TAG) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          From
          <ThreadLinkChip
            environmentId={props.environmentId}
            threadId={tagged.threadId}
            label={tagged.title || "coordinator"}
          />
        </span>
        {props.renderUserRow(bodyRow)}
      </div>
    );
  }
  return (
    <ThreadUpdateCard
      update={tagged}
      environmentId={props.environmentId}
      threadRef={props.threadRef}
      markdownCwd={props.markdownCwd}
      isLatest={isLatest}
    />
  );
}

/** Answers taller than this start clamped, with a toggle to show all of it. */
const CLAMPED_ANSWER_HEIGHT_PX = 320;

export function ThreadUpdateCard(props: {
  update: ParsedTaggedThreadMessage;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  isLatest: boolean;
}) {
  const { update } = props;
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? props.isLatest;
  const childRef = useMemo(
    () => scopeThreadRef(props.environmentId, update.threadId as ThreadId),
    [props.environmentId, update.threadId],
  );
  const answerCwd = useChildAnswerCwd(childRef);
  // The update carries the child's full answer.
  const text = update.body;
  const hasBody = text.trim().length > 0;
  return (
    <div className="rounded-xl border border-border/70 bg-card/40 text-sm">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            update.state ? CHILD_THREAD_DOT_CLASS[update.state] : "bg-muted-foreground/40",
          )}
        />
        <ThreadLinkChip
          environmentId={props.environmentId}
          threadId={update.threadId}
          label={update.title || "Thread"}
        />
        <span className="min-w-0 truncate text-muted-foreground">
          {[update.state ? CHILD_THREAD_STATE_LABELS[update.state] : null, update.detail]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {hasBody ? (
          <button
            type="button"
            onClick={() => setToggled(!open)}
            aria-expanded={open}
            aria-label={open ? "Hide the thread's answer" : "Show the thread's answer"}
            className="ms-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
      {open && hasBody ? (
        <ChildAnswerBody
          text={text}
          cwd={props.markdownCwd}
          answerCwd={answerCwd}
          threadRef={props.threadRef}
        />
      ) : null}
    </div>
  );
}

/**
 * The child's answer, with its relative paths anchored at the child's
 * directory while links still open in the coordinator's panels.
 */
function ChildAnswerBody(props: {
  text: string;
  cwd: string | undefined;
  answerCwd: string | undefined;
  threadRef: ScopedThreadRef | null;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Measured on every resize, since highlighting and media grow the answer after it mounts.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setOverflows(element.offsetHeight > CLAMPED_ANSWER_HEIGHT_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const clamped = overflows && !expanded;
  return (
    <div className="border-t border-border/60 px-3 py-2">
      <div
        className={cn(
          "overflow-hidden",
          clamped && "[mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
        )}
        style={clamped ? { maxHeight: CLAMPED_ANSWER_HEIGHT_PX } : undefined}
      >
        <div ref={contentRef}>
          <ChatMarkdown
            text={props.text}
            cwd={props.cwd}
            imageBaseDir={props.answerCwd ?? props.cwd}
            threadRef={props.threadRef ?? undefined}
          />
        </div>
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}
