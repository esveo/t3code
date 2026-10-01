import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { TimelineEntry } from "../../session-logic";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { buildChatFindPattern, type ChatFindMatch } from "../chat/ChatFind.logic";
import { cn } from "~/lib/utils";
import {
  buildChatFindResults,
  chatFindResultWindow,
  type ChatFindResultSource,
} from "./chatFindResults.logic";

const SOURCE_LABEL: Record<ChatFindResultSource, string> = {
  user: "You",
  assistant: "Agent",
  plan: "Plan",
};

/**
 * Fork: the matches of find in thread as a list under the find bar. Each row
 * shows who wrote it and the text around the hit; clicking one jumps there.
 * The active row follows Enter and the arrow keys in the bar.
 */
export function ChatFindResults({
  query,
  entries,
  matches,
  activeIndex,
  cwd,
  timestampFormat,
  onSelect,
}: {
  query: string;
  entries: ReadonlyArray<TimelineEntry>;
  matches: ReadonlyArray<ChatFindMatch>;
  activeIndex: number;
  cwd: string | undefined;
  timestampFormat: TimestampFormat;
  onSelect: (index: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pattern = useMemo(() => buildChatFindPattern(query), [query]);
  const { start, end } = chatFindResultWindow(matches.length, activeIndex);
  const results = useMemo(
    () =>
      pattern === null || collapsed
        ? []
        : buildChatFindResults({ entries, matches, pattern, cwd, start, end }),
    [collapsed, cwd, end, entries, matches, pattern, start],
  );
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  // Keep the active row in sight as Enter steps through the list.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, collapsed]);

  if (pattern === null || matches.length === 0) return null;

  return (
    <div className="surface-glass absolute top-12 right-4 z-30 flex w-[min(28rem,calc(100%-2rem))] flex-col overflow-hidden rounded-lg border border-border/60 shadow-sm">
      <button
        type="button"
        aria-expanded={!collapsed}
        // Keep the caret in the find input.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setCollapsed((value) => !value)}
        className="flex items-center gap-1 px-2 py-1.5 text-left text-muted-foreground text-xs hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
        {matches.length === 1 ? "1 result" : `${matches.length} results`}
        {end - start < matches.length ? (
          <span className="ml-auto tabular-nums">
            showing {start + 1}–{end}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <div role="listbox" aria-label="Find results" className="max-h-80 overflow-y-auto p-1 pt-0">
          {results.map((result) => {
            const active = result.index === activeIndex;
            return (
              <button
                key={result.index}
                ref={active ? activeRowRef : undefined}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(result.index)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-foreground/[0.06]",
                )}
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-medium">{SOURCE_LABEL[result.source]}</span>
                  <span className="ml-auto tabular-nums">
                    {formatDayAwareTimestamp(result.createdAt, timestampFormat)}
                  </span>
                </span>
                <span className="line-clamp-2 break-words text-foreground">
                  {result.snippet.before}
                  <mark className="rounded-sm bg-primary/30 text-inherit">
                    {result.snippet.hit}
                  </mark>
                  {result.snippet.after}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
