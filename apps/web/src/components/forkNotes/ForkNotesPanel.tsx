/**
 * Fork: the Notes tab. Notes and todos of the thread, its project and the
 * whole environment, one list at a time. Entries are dragged to reorder,
 * into the Done group to check them off, or onto another scope to move them.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { ForkNote, ForkNoteScope, ForkNotesTarget, ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  ListTodoIcon,
  StickyNoteIcon,
  TextCursorInputIcon,
} from "lucide-react";
import { type DragEvent, type KeyboardEvent, useMemo, useRef, useState } from "react";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Toggle as ToggleGroupItem, ToggleGroup } from "~/components/ui/toggle-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  FORK_NOTE_SCOPE_LABELS,
  FORK_NOTE_SCOPES,
  type ForkNoteDropTarget,
  forkNotesTargetKey,
  forkNotesTargets,
  openTodoCount,
  parseForkNoteText,
  resolveForkNoteDrop,
} from "./forkNotesLogic";
import { useForkNotesStore } from "./forkNotesStore";
import { toastWithUndo, useForkNotes } from "./useForkNotes";

export function ForkNotesPanel({
  threadRef,
  composerDraftTarget,
}: {
  threadRef: ScopedThreadRef | null;
  composerDraftTarget: ComposerThreadTarget;
}) {
  if (!threadRef) return null;
  return <ForkNotes threadRef={threadRef} composerDraftTarget={composerDraftTarget} />;
}

/** Open entries first, then the done ones, each in their saved order. */
const partition = (notes: ReadonlyArray<ForkNote>) => [
  ...notes.filter((note) => !note.done),
  ...notes.filter((note) => note.done),
];

const sameDropTarget = (left: ForkNoteDropTarget | null, right: ForkNoteDropTarget | null) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The scope a thread shows: its remembered one while that list exists. */
function useScope(threadKey: string, targets: Record<ForkNoteScope, ForkNotesTarget | null>) {
  const stored = useForkNotesStore((state) => state.scopeByThreadKey[threadKey]);
  const setScope = useForkNotesStore((state) => state.setScope);
  const scope = stored && targets[stored] ? stored : "thread";
  return [scope, (next: ForkNoteScope) => setScope(threadKey, next)] as const;
}

function ForkNotes({
  threadRef,
  composerDraftTarget,
}: {
  threadRef: ScopedThreadRef;
  composerDraftTarget: ComposerThreadTarget;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  const targets = useMemo(
    () => forkNotesTargets({ threadId: threadRef.threadId, projectId }),
    [threadRef.threadId, projectId],
  );
  const { lists, act } = useForkNotes(threadRef.environmentId, targets);
  const [scope, setScope] = useScope(threadKey, targets);
  const list = lists[scope];
  const notes = useMemo(() => partition(list.notes), [list.notes]);
  const target = list.target;
  const listKey = target ? forkNotesTargetKey(target) : scope;
  const doneOpen = useForkNotesStore((state) => state.doneOpenByList[listKey] ?? false);
  const setDoneOpen = useForkNotesStore((state) => state.setDoneOpen);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const captureShortcut = shortcutLabelForCommand(keybindings, "notes.capture");

  const [dragging, setDragging] = useState<ForkNote | null>(null);
  const [dropTarget, setDropTargetState] = useState<ForkNoteDropTarget | null>(null);
  const [scopeDrop, setScopeDrop] = useState<ForkNoteScope | null>(null);
  const setDropTarget = (next: ForkNoteDropTarget | null) =>
    setDropTargetState((previous) => (sameDropTarget(previous, next) ? previous : next));

  const openNotes = notes.filter((note) => !note.done);
  const doneNotes = notes.filter((note) => note.done);

  const indexOf = (note: ForkNote) => notes.findIndex((entry) => entry.id === note.id);

  const remove = (note: ForkNote) => {
    if (!target) return;
    const position = indexOf(note);
    void act({ type: "delete", id: note.id });
    toastWithUndo(note.todo ? "Todo deleted" : "Note deleted", () => {
      void act({
        type: "create",
        ...target,
        id: note.id,
        text: note.text,
        todo: note.todo,
        done: note.done,
        position,
      });
    });
  };

  const moveToScope = (note: ForkNote, nextScope: ForkNoteScope) => {
    const destination = targets[nextScope];
    if (!target || !destination || nextScope === scope) return;
    const position = indexOf(note);
    void act({ type: "move", id: note.id, ...destination, position: 0 });
    toastWithUndo(`Moved to ${FORK_NOTE_SCOPE_LABELS[nextScope]}`, () => {
      void act({ type: "move", id: note.id, ...target, position, done: note.done });
    });
  };

  /** Checks a todo off into the top of Done, or reopens it at the end of the open ones. */
  const setDone = (note: ForkNote, done: boolean) => {
    if (!target) return;
    const placed = resolveForkNoteDrop(
      notes,
      note.id,
      done ? { kind: "done-head" } : { kind: "open-end" },
    );
    if (!placed) return;
    void act({ type: "move", id: note.id, ...target, position: placed.position, done });
  };

  const setTodo = (note: ForkNote, todo: boolean) => {
    if (!target) return;
    if (!todo && note.done) {
      // A note never sits in Done, so it leaves the group first.
      const placed = resolveForkNoteDrop(notes, note.id, { kind: "open-end" });
      void act({
        type: "move",
        id: note.id,
        ...target,
        position: placed?.position ?? 0,
        done: false,
      }).then((ok) => ok && act({ type: "update", id: note.id, todo }));
      return;
    }
    void act({ type: "update", id: note.id, todo });
  };

  const saveText = (note: ForkNote, text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) remove(note);
    else if (trimmed !== note.text) void act({ type: "update", id: note.id, text: trimmed });
  };

  const insertIntoComposer = (note: ForkNote) => {
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const trimmed = current.trimEnd();
    store.setPrompt(composerDraftTarget, trimmed ? `${trimmed}\n${note.text}` : note.text);
    toastManager.add({ type: "success", title: "Inserted into the composer", timeout: 2000 });
  };

  const copy = (note: ForkNote) => {
    void navigator.clipboard.writeText(note.text).then(
      () => toastManager.add({ type: "success", title: "Copied", timeout: 2000 }),
      () => toastManager.add({ type: "error", title: "Could not copy the note" }),
    );
  };

  // Drag and drop. Rows, the gap above Done and the Done header each claim
  // the pointer; the list itself catches the rest.
  const claim = (event: DragEvent, next: ForkNoteDropTarget) => {
    if (!dragging) return;
    event.stopPropagation();
    if (resolveForkNoteDrop(notes, dragging.id, next)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(next);
    } else {
      setDropTarget(null);
    }
  };

  const fallbackTarget = (): ForkNoteDropTarget => {
    const lastDone = doneNotes.at(-1);
    return doneOpen && lastDone && dragging?.todo
      ? { kind: "row", id: lastDone.id, after: true }
      : { kind: "open-end" };
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    const note = dragging;
    const where = dropTarget;
    setDragging(null);
    setDropTarget(null);
    if (!note || !where || !target) return;
    const placed = resolveForkNoteDrop(notes, note.id, where);
    if (!placed) return;
    const position = indexOf(note);
    if (placed.position === position && placed.done === note.done) return;
    void act({ type: "move", id: note.id, ...target, ...placed });
    if (placed.done !== note.done) {
      toastWithUndo(placed.done ? "Marked done" : "Reopened", () => {
        void act({ type: "move", id: note.id, ...target, position, done: note.done });
      });
    }
  };

  const endDrag = () => {
    setDragging(null);
    setDropTarget(null);
    setScopeDrop(null);
  };

  const rowProps = (note: ForkNote) => ({
    note,
    dragging: dragging?.id === note.id,
    dropEdge:
      dropTarget?.kind === "row" && dropTarget.id === note.id
        ? dropTarget.after
          ? ("after" as const)
          : ("before" as const)
        : null,
    otherScopes: FORK_NOTE_SCOPES.filter((other) => other !== scope && targets[other] !== null),
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", note.text);
      setDragging(note);
    },
    onDragEnd: endDrag,
    onDragOver: (event: DragEvent) => {
      const rect = event.currentTarget.getBoundingClientRect();
      claim(event, { kind: "row", id: note.id, after: event.clientY > rect.top + rect.height / 2 });
    },
    onSetDone: (done: boolean) => setDone(note, done),
    onSetTodo: (todo: boolean) => setTodo(note, todo),
    onSave: (text: string) => saveText(note, text),
    onDelete: () => remove(note),
    onMove: (next: ForkNoteScope) => moveToScope(note, next),
    onCopy: () => copy(note),
    onInsert: () => insertIntoComposer(note),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <ToggleGroup
          className="w-full *:flex-1"
          // A scope an entry is dragged over shows as selected: that is where it lands.
          value={[scopeDrop ?? scope]}
          onValueChange={(next) => {
            const [selected] = next;
            if (selected === "thread" || selected === "project" || selected === "global") {
              setScope(selected);
            }
          }}
        >
          {FORK_NOTE_SCOPES.map((option) => {
            const count = openTodoCount(lists[option].notes);
            return (
              <ToggleGroupItem
                key={option}
                value={option}
                disabled={targets[option] === null}
                aria-label={FORK_NOTE_SCOPE_LABELS[option]}
                onDragOver={(event) => {
                  if (!dragging || option === scope || targets[option] === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setScopeDrop(option);
                }}
                onDragLeave={() => setScopeDrop(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  const note = dragging;
                  endDrag();
                  if (note) moveToScope(note, option);
                }}
              >
                {FORK_NOTE_SCOPE_LABELS[option]}
                {count > 0 ? <span className="tabular-nums opacity-70">{count}</span> : null}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        {target ? <AddField target={target} act={act} /> : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div
          className="flex min-h-full flex-col px-3 pb-3"
          onDragOver={(event) => claim(event, fallbackTarget())}
          onDrop={drop}
        >
          {list.error ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{list.error}</p>
          ) : !list.loaded ? null : notes.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              Nothing here yet.
              {captureShortcut ? ` Capture something with ${captureShortcut}.` : null}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                {openNotes.map((note) => (
                  <ForkNoteRow key={note.id} {...rowProps(note)} />
                ))}
              </div>
              {doneNotes.length > 0 ? (
                <>
                  {/* The gap above Done only reorders; it never checks anything off. */}
                  <div className="h-2" onDragOver={(event) => claim(event, { kind: "open-end" })} />
                  <button
                    type="button"
                    aria-expanded={doneOpen}
                    onClick={() => setDoneOpen(listKey, !doneOpen)}
                    onDragOver={(event) => claim(event, { kind: "done-head" })}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                      dropTarget?.kind === "done-head" && "ring-2 ring-primary",
                    )}
                  >
                    <ChevronDownIcon
                      aria-hidden
                      className={cn("size-3.5 transition-transform", !doneOpen && "-rotate-90")}
                    />
                    Done
                    <span className="font-normal tabular-nums text-muted-foreground/80">
                      {doneNotes.length}
                    </span>
                  </button>
                  {doneOpen ? (
                    <div className="flex flex-col gap-0.5 py-1">
                      {doneNotes.map((note) => (
                        <ForkNoteRow key={note.id} {...rowProps(note)} />
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
              <div className="min-h-6 flex-1" />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function AddField({
  target,
  act,
}: {
  target: ForkNotesTarget;
  act: ReturnType<typeof useForkNotes>["act"];
}) {
  const [text, setText] = useState("");
  const asTodo = useForkNotesStore((state) => state.addAsTodo);
  const setAsTodo = useForkNotesStore((state) => state.setAddAsTodo);
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    void act({ type: "create", ...target, text: trimmed, todo: asTodo });
  };
  return (
    <div className="flex items-start gap-1 rounded-lg border border-input bg-background px-2 py-1 focus-within:ring-2 focus-within:ring-ring dark:bg-input/32">
      <textarea
        value={text}
        rows={1}
        aria-label={asTodo ? "Add a todo" : "Add a note"}
        placeholder={asTodo ? "Add a todo…" : "Add a note…"}
        className="field-sizing-content max-h-40 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <Toggle
        size="xs"
        variant="ghost"
        pressed={asTodo}
        onPressedChange={setAsTodo}
        aria-label="Add as todo"
      >
        <ListTodoIcon />
        Todo
      </Toggle>
    </div>
  );
}

/** Plain text with `inline code` and links; nothing else is formatted. */
function ForkNoteText({ text }: { text: string }) {
  const parts = useMemo(() => parseForkNoteText(text), [text]);
  return (
    <>
      {parts.map((part) =>
        part.kind === "code" ? (
          <code key={part.start} className="rounded bg-muted px-1 font-mono text-xs">
            {part.text}
          </code>
        ) : part.kind === "link" ? (
          <a
            key={part.start}
            href={part.text}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {part.text}
          </a>
        ) : (
          <span key={part.start}>{part.text}</span>
        ),
      )}
    </>
  );
}

function ForkNoteRow(props: {
  note: ForkNote;
  dragging: boolean;
  dropEdge: "before" | "after" | null;
  otherScopes: ReadonlyArray<ForkNoteScope>;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  onSetDone: (done: boolean) => void;
  onSetTodo: (todo: boolean) => void;
  onSave: (text: string) => void;
  onDelete: () => void;
  onMove: (scope: ForkNoteScope) => void;
  onCopy: () => void;
  onInsert: () => void;
}) {
  const { note } = props;
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const cancelled = useRef(false);

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      props.onDelete();
    } else if (event.key === "Enter") {
      event.preventDefault();
      setEditing(true);
    }
  };

  return (
    <div
      role="listitem"
      tabIndex={0}
      draggable={!editing}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onKeyDown={onRowKeyDown}
      className={cn(
        "group relative flex items-start gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        props.dragging && "opacity-50",
      )}
    >
      {props.dropEdge ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
            props.dropEdge === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      <span className="flex h-5 shrink-0 items-center">
        {note.todo ? (
          <Checkbox
            checked={note.done}
            onCheckedChange={(checked) => props.onSetDone(checked === true)}
            aria-label={note.done ? "Reopen" : "Mark done"}
          />
        ) : (
          <StickyNoteIcon aria-hidden className="size-4 text-muted-foreground" />
        )}
      </span>
      {editing ? (
        <textarea
          autoFocus
          defaultValue={note.text}
          aria-label="Edit"
          className="field-sizing-content min-h-5 flex-1 resize-none bg-transparent text-sm leading-5 outline-none"
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelled.current = true;
              setEditing(false);
            } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => {
            if (!cancelled.current) props.onSave(event.currentTarget.value);
            cancelled.current = false;
            setEditing(false);
          }}
        />
      ) : (
        <div
          className={cn(
            "min-w-0 flex-1 cursor-text whitespace-pre-wrap break-words text-sm leading-5",
            note.done && "text-muted-foreground line-through",
          )}
          onClick={() => setEditing(true)}
        >
          <ForkNoteText text={note.text} />
        </div>
      )}
      {editing ? null : (
        <div
          className={cn(
            "flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            menuOpen && "opacity-100",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Copy"
                  onClick={props.onCopy}
                >
                  <CopyIcon />
                </Button>
              }
            />
            <TooltipPopup>Copy</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Insert into composer"
                  onClick={props.onInsert}
                >
                  <TextCursorInputIcon />
                </Button>
              }
            />
            <TooltipPopup>Insert into composer</TooltipPopup>
          </Tooltip>
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost-muted" aria-label="More actions">
                  <EllipsisIcon />
                </Button>
              }
            />
            <MenuPopup align="end">
              <MenuItem onClick={() => props.onSetTodo(!note.todo)}>
                {note.todo ? <StickyNoteIcon /> : <ListTodoIcon />}
                {note.todo ? "Turn into note" : "Turn into todo"}
              </MenuItem>
              {props.otherScopes.map((scope) => (
                <MenuItem key={scope} onClick={() => props.onMove(scope)}>
                  Move to {FORK_NOTE_SCOPE_LABELS[scope]}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={props.onDelete}>
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
    </div>
  );
}
