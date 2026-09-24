import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  CHILD_THREAD_STATE_LABELS,
  FROM_COORDINATOR_TAG,
  parseTaggedThreadMessage,
  parseThreadUpdates,
  type TaggedThreadMessage as ParsedTaggedThreadMessage,
} from "@t3tools/shared/threadOrchestration";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";
import { CHILD_THREAD_DOT_CLASS } from "./childThreadStateVisuals";
import { ThreadLinkChip } from "./ThreadLinkChip";

interface TaggedRow {
  readonly message: { readonly text: string };
}

/**
 * Fork: messages between a coordinator and its threads. A child's update to
 * its coordinator reads as a compact card with the child's chip and state; a
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
        ? ({ ...props.row, message: { ...props.row.message, text: tagged.body } } as Row)
        : props.row,
    [props.row, tagged],
  );
  const bundle = useMemo(
    () => (tagged ? null : parseThreadUpdates(props.row.message.text)),
    [props.row.message.text, tagged],
  );
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
    />
  );
}

function ThreadUpdateCard(props: {
  update: ParsedTaggedThreadMessage;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
}) {
  const { update } = props;
  const [open, setOpen] = useState(false);
  const hasBody = update.body.trim().length > 0;
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
            onClick={() => setOpen((value) => !value)}
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
        <div className="border-t border-border/60 px-3 py-2">
          <ChatMarkdown
            text={update.body}
            cwd={props.markdownCwd}
            threadRef={props.threadRef ?? undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
