/**
 * Fork: the Notes tab's pure rules: which scopes a thread sees, the counts,
 * where a drop lands, and how an action changes a list before the server
 * confirms it.
 */
import type { ForkNote, ForkNoteScope, ForkNotesAction, ForkNotesTarget } from "@t3tools/contracts";

export const FORK_NOTE_SCOPES = [
  "thread",
  "project",
  "global",
] as const satisfies ReadonlyArray<ForkNoteScope>;

export const FORK_NOTE_SCOPE_LABELS: Record<ForkNoteScope, string> = {
  thread: "Thread",
  project: "Project",
  global: "Global",
};

export type ForkNotesTargets = Record<ForkNoteScope, ForkNotesTarget | null>;

/** The three lists a thread sees; a scope without an id is unavailable. */
export function forkNotesTargets(input: {
  readonly threadId: string | null;
  readonly projectId: string | null;
}): ForkNotesTargets {
  return {
    thread: input.threadId ? { scope: "thread", scopeId: input.threadId } : null,
    project: input.projectId ? { scope: "project", scopeId: input.projectId } : null,
    global: { scope: "global", scopeId: "" },
  };
}

export const forkNotesTargetKey = (target: ForkNotesTarget) => `${target.scope}:${target.scopeId}`;

export const openTodoCount = (notes: ReadonlyArray<ForkNote>) =>
  notes.filter((note) => note.todo && !note.done).length;

/**
 * Where a dragged entry is dropped within its list: before or after a row,
 * on the Done header, or in the open area below the last open row.
 */
export type ForkNoteDropTarget =
  | { readonly kind: "row"; readonly id: string; readonly after: boolean }
  | { readonly kind: "done-head" }
  | { readonly kind: "open-end" };

/**
 * The position and done state a drop asks the server for. Positions count the
 * scope's list without the dragged entry. Rows of the Done group make the
 * entry done, open rows and the open area reopen it; notes never become done.
 */
export function resolveForkNoteDrop(
  notes: ReadonlyArray<ForkNote>,
  draggedId: string,
  target: ForkNoteDropTarget,
): { readonly position: number; readonly done: boolean } | null {
  const dragged = notes.find((note) => note.id === draggedId);
  if (!dragged) return null;
  const others = notes.filter((note) => note.id !== draggedId);
  const firstDone = others.findIndex((note) => note.done);
  const openEnd = firstDone === -1 ? others.length : firstDone;
  switch (target.kind) {
    case "row": {
      const index = others.findIndex((note) => note.id === target.id);
      const reference = others[index];
      if (!reference) return null;
      if (reference.done && !dragged.todo) return null;
      return { position: index + (target.after ? 1 : 0), done: reference.done };
    }
    case "done-head":
      return dragged.todo ? { position: openEnd, done: true } : null;
    case "open-end": {
      let lastOpen = -1;
      others.forEach((note, index) => {
        if (!note.done) lastOpen = index;
      });
      return { position: lastOpen + 1, done: false };
    }
  }
}

const insertAt = <A>(items: ReadonlyArray<A>, position: number, item: A) => {
  const index = Math.max(0, Math.min(position, items.length));
  return [...items.slice(0, index), item, ...items.slice(index)];
};

const renumber = (notes: ReadonlyArray<ForkNote>) =>
  notes.map((note, position) => (note.position === position ? note : { ...note, position }));

/**
 * Applies an action to the lists it touches, as the server will, so the panel
 * shows the result right away. Keyed by `forkNotesTargetKey`; lists the
 * caller does not hold are left out of the result.
 */
export function applyForkNotesAction(
  lists: ReadonlyMap<string, ReadonlyArray<ForkNote>>,
  action: ForkNotesAction,
  now: string,
): Map<string, ReadonlyArray<ForkNote>> {
  const next = new Map<string, ReadonlyArray<ForkNote>>();
  const read = (key: string) => next.get(key) ?? lists.get(key);
  const locate = (id: string) => {
    for (const [key, notes] of lists) {
      const note = notes.find((candidate) => candidate.id === id);
      if (note) return { key, note };
    }
    return null;
  };
  switch (action.type) {
    case "create": {
      const key = forkNotesTargetKey(action);
      const notes = read(key);
      if (!notes) return next;
      const note: ForkNote = {
        id: action.id ?? `pending:${now}`,
        scope: action.scope,
        scopeId: action.scopeId,
        text: action.text,
        todo: action.todo,
        done: action.todo && (action.done ?? false),
        position: 0,
        createdAt: now,
        updatedAt: now,
      };
      next.set(key, renumber(insertAt(notes, action.position ?? 0, note)));
      return next;
    }
    case "update": {
      const found = locate(action.id);
      if (!found) return next;
      const todo = action.todo ?? found.note.todo;
      const updated: ForkNote = {
        ...found.note,
        text: action.text ?? found.note.text,
        todo,
        done: todo && (action.done ?? found.note.done),
        updatedAt: now,
      };
      next.set(
        found.key,
        (read(found.key) ?? []).map((note) => (note.id === action.id ? updated : note)),
      );
      return next;
    }
    case "move": {
      const found = locate(action.id);
      if (!found) return next;
      const key = forkNotesTargetKey(action);
      const moved: ForkNote = {
        ...found.note,
        scope: action.scope,
        scopeId: action.scopeId,
        done: found.note.todo && (action.done ?? found.note.done),
        updatedAt: now,
      };
      if (key !== found.key) {
        next.set(
          found.key,
          renumber((read(found.key) ?? []).filter((note) => note.id !== action.id)),
        );
      }
      const target = read(key);
      if (target) {
        const others = target.filter((note) => note.id !== action.id);
        next.set(key, renumber(insertAt(others, action.position, moved)));
      }
      return next;
    }
    case "delete": {
      const found = locate(action.id);
      if (!found) return next;
      next.set(
        found.key,
        renumber((read(found.key) ?? []).filter((note) => note.id !== action.id)),
      );
      return next;
    }
  }
}

/** One run of a note's text; `start` is its offset, unique within the note. */
export interface ForkNoteTextPart {
  readonly kind: "text" | "code" | "link";
  readonly text: string;
  readonly start: number;
}

const INLINE_PATTERN = /`([^`\n]+)`|(https?:\/\/[^\s<]+[^\s<.,:;)\]'"])/g;

/** Splits a note into plain text, `inline code` and bare links. */
export function parseForkNoteText(text: string): ReadonlyArray<ForkNoteTextPart> {
  const parts: ForkNoteTextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index), start: last });
    if (match[1] !== undefined) parts.push({ kind: "code", text: match[1], start: index });
    else parts.push({ kind: "link", text: match[0], start: index });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last), start: last });
  return parts;
}
