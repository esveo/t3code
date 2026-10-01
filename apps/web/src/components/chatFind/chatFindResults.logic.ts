import type { TimelineEntry } from "../../session-logic";
import {
  chatFindEntrySource,
  findPatternSpans,
  type ChatFindMatch,
  type TextSpan,
} from "../chat/ChatFind.logic";

/** Characters of context shown before and after a hit in the result list. */
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 90;
/** Rows the result list renders at once; long lists show a window around the active hit. */
export const CHAT_FIND_RESULT_WINDOW = 150;

export type ChatFindResultSource = "user" | "assistant" | "plan";

export interface ChatFindSnippet {
  readonly before: string;
  readonly hit: string;
  readonly after: string;
}

export interface ChatFindResult {
  /** Position in the full match list, the index stepping and selection use. */
  readonly index: number;
  readonly source: ChatFindResultSource;
  readonly createdAt: string;
  readonly snippet: ChatFindSnippet;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** One line of text around the hit, trimmed to whole words where it is cut. */
export function buildChatFindSnippet(text: string, span: TextSpan): ChatFindSnippet {
  let start = Math.max(0, span.start - CONTEXT_BEFORE);
  let end = Math.min(text.length, span.end + CONTEXT_AFTER);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < span.start) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > span.end) end = space;
  }
  return {
    before: (start > 0 ? "…" : "") + collapseWhitespace(text.slice(start, span.start)).trimStart(),
    hit: collapseWhitespace(text.slice(span.start, span.end)),
    after: collapseWhitespace(text.slice(span.end, end)).trimEnd() + (end < text.length ? "…" : ""),
  };
}

/** The slice of the match list to render, kept around the active match. */
export function chatFindResultWindow(
  total: number,
  activeIndex: number,
  size = CHAT_FIND_RESULT_WINDOW,
): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const start = Math.min(Math.max(0, activeIndex - Math.floor(size / 2)), total - size);
  return { start, end: start + size };
}

function resultSource(entry: TimelineEntry): ChatFindResultSource | null {
  if (entry.kind === "proposed-plan") return "plan";
  if (entry.kind === "message" && entry.message.role !== "system") return entry.message.role;
  return null;
}

/**
 * Snippets for the matches in `[start, end)`. Reads the same normalized text
 * the match count comes from, so a result's occurrence points at its own hit.
 */
export function buildChatFindResults(input: {
  entries: ReadonlyArray<TimelineEntry>;
  matches: ReadonlyArray<ChatFindMatch>;
  pattern: RegExp;
  cwd: string | undefined;
  start: number;
  end: number;
}): ChatFindResult[] {
  const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const spansByEntryId = new Map<string, { text: string; spans: TextSpan[] }>();
  const results: ChatFindResult[] = [];
  for (let index = input.start; index < input.end; index += 1) {
    const match = input.matches[index];
    const entry = match ? entriesById.get(match.entryId) : undefined;
    if (!match || !entry) continue;
    const source = resultSource(entry);
    if (source === null) continue;
    let cached = spansByEntryId.get(entry.id);
    if (!cached) {
      const text = chatFindEntrySource(entry, input.cwd)?.text ?? "";
      cached = { text, spans: findPatternSpans(text, input.pattern) };
      spansByEntryId.set(entry.id, cached);
    }
    const span = cached.spans[match.occurrence];
    if (!span) continue;
    results.push({
      index,
      source,
      createdAt: entry.createdAt,
      snippet: buildChatFindSnippet(cached.text, span),
    });
  }
  return results;
}
