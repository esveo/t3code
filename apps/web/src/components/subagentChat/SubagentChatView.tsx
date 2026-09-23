/**
 * Fork: one subagent's conversation as a chat inside the Agents panel.
 *
 * The transcript streams from the server while this view is mounted. Messages
 * typed here go to the parent as a normal turn asking it to relay them with
 * SendMessage, since only the parent can reach its subagents; they show up in
 * the parent's chat as well, so nothing is sent behind the user's back.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, SubagentTranscriptEntry, ThreadId } from "@t3tools/contracts";
import { ChevronDown, ChevronLeft, ChevronRight, SendHorizontal, Square } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn, newMessageId } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  buildSubagentRelayMessage,
  deriveSubagentChatRows,
  isLiveSubagent,
  type SubagentChatRow,
} from "./subagentChat.logic";
import { subagentChatEnvironment } from "./subagentChatState";

/** Within this distance of the bottom the view follows new output. */
const FOLLOW_THRESHOLD_PX = 48;

function ToolRow({
  call,
  result,
}: {
  call: SubagentTranscriptEntry | null;
  result: SubagentTranscriptEntry | null;
}) {
  // Bodies render on open only: a long run holds hundreds of tool rows.
  const [open, setOpen] = useState(false);
  const pending = call !== null && result === null;
  return (
    <div className="rounded-md border border-border/50 bg-card/30">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "shrink-0 font-mono text-[.7rem]",
            result?.isError ? "text-destructive-foreground" : "text-foreground/80",
          )}
        >
          {call?.toolName ?? "Tool result"}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{call?.text}</span>
        {pending ? (
          <span className="ml-auto shrink-0 text-muted-foreground/70">running…</span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-border/50 p-2">
          {call?.input ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[.7rem] text-muted-foreground">
              {call.input}
            </pre>
          ) : null}
          {result ? (
            <pre
              className={cn(
                "max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[.7rem]",
                result.isError ? "text-destructive-foreground" : "text-foreground/85",
              )}
            >
              {result.text.length > 0 ? result.text : "(no output)"}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      className="w-full text-left text-xs text-muted-foreground/80 hover:text-muted-foreground"
    >
      <span className="block truncate italic">
        {open ? "Thinking" : `Thinking · ${text.split("\n")[0]}`}
      </span>
      {open ? <p className="mt-1 whitespace-pre-wrap italic">{text}</p> : null}
    </button>
  );
}

const TranscriptRow = memo(function TranscriptRow({
  row,
  cwd,
  isFirstPrompt,
}: {
  row: SubagentChatRow;
  cwd: string | undefined;
  isFirstPrompt: boolean;
}) {
  switch (row.kind) {
    case "prompt":
      return (
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[.65rem] uppercase tracking-wider text-muted-foreground/70">
            {isFirstPrompt ? "Task" : "Message"}
          </span>
          <div className="max-h-80 max-w-[92%] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-secondary/60 px-2.5 py-1.5 text-sm">
            {row.text}
          </div>
        </div>
      );
    case "text":
      return <ChatMarkdown text={row.text} cwd={cwd} className="text-sm" />;
    case "thinking":
      return <ThinkingRow text={row.text} />;
    case "tool":
      return <ToolRow call={row.call} result={row.result} />;
  }
});

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
  const transcript = useEnvironmentQuery(
    subagentChatEnvironment.transcript({
      environmentId,
      input: { threadId, agentId: agent.id },
    }),
  );
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const stop = useAtomCommand(subagentChatEnvironment.stop);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);

  const entries = transcript.data?.entries;
  const rows = useMemo(() => deriveSubagentChatRows(entries ?? []), [entries]);
  const firstPromptId = rows.find((row) => row.kind === "prompt")?.id;
  const live = isLiveSubagent(agent);

  // Follow new output while the user sits at the bottom; leave them alone
  // once they scroll up to read.
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const rowCount = rows.length;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && rowCount > 0 && followRef.current) element.scrollTop = element.scrollHeight;
  }, [rowCount]);

  const send = async () => {
    const text = draft.trim();
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
    if (result._tag === "Success") setDraft("");
  };

  const stopAgent = async () => {
    setStopping(true);
    await stop({ environmentId, input: { threadId, agentId: agent.id } });
    setStopping(false);
  };

  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onBack}
          aria-label="Back to agents"
        >
          <ChevronLeft aria-hidden className="size-3.5" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{agent.title}</span>
          <span className="truncate font-mono text-[.65rem] text-muted-foreground">
            {[agent.role, modelLabel, live ? "working" : agent.status].filter(Boolean).join(" · ")}
          </span>
        </div>
        {live ? (
          <Button size="compact" variant="outline" onClick={stopAgent} disabled={stopping}>
            <Square aria-hidden />
            Stop
          </Button>
        ) : null}
      </header>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex flex-col gap-2 p-2.5">
          {transcript.error ? (
            <p className="text-xs text-destructive-foreground">{transcript.error}</p>
          ) : transcript.data === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : !transcript.data.found ? (
            <p className="text-xs text-muted-foreground">
              {live ? "Waiting for the transcript…" : "No transcript is available for this agent."}
            </p>
          ) : null}
          {transcript.data?.truncated ? (
            <p className="text-center text-[.65rem] text-muted-foreground/70">
              Earlier messages are not shown.
            </p>
          ) : null}
          {rows.map((row) => (
            <TranscriptRow
              key={row.id}
              row={row}
              cwd={thread?.worktreePath ?? undefined}
              isFirstPrompt={row.id === firstPromptId}
            />
          ))}
        </div>
      </div>
      <form
        className="flex items-end gap-1.5 border-t border-border/60 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          size="sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            live
              ? "Message this agent (via the main agent)"
              : "Resume this agent (via the main agent)"
          }
          aria-label="Message to the agent"
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={draft.trim().length === 0 || thread === null || sending}
          aria-label="Send to agent"
        >
          <SendHorizontal aria-hidden />
        </Button>
      </form>
    </div>
  );
}
