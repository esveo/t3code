/**
 * Fork: quick capture into the Notes tab, from anywhere. `notes.capture`
 * opens it, prefilled with text selected in the chat; `notes.open` opens the
 * Notes tab of the current thread. Mounted once in the root route, next to
 * the command palette entries below.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ForkNoteScope, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { ListTodoIcon, NotebookPenIcon, PencilLineIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { getTerminalFocusOwner } from "~/lib/terminalFocus";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";
import { Toggle as ToggleGroupItem, ToggleGroup } from "../ui/toggle-group";
import { FORK_NOTE_SCOPE_LABELS, FORK_NOTE_SCOPES, forkNotesTargets } from "./forkNotesLogic";
import { useForkNotesCaptureStore, useForkNotesStore } from "./forkNotesStore";
import { useForkNotesAct } from "./useForkNotes";

/** Text the user selected in the chat's messages, or "". */
function chatSelection(): string {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (!selection || !element?.closest("[data-timeline-root]")) return "";
  return selection.toString().trim();
}

/** The thread (or draft) the route shows, as far as notes care. */
function useRouteNotesContext() {
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const thread = useThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    threadRef,
    environmentId: threadRef?.environmentId ?? draft?.environmentId ?? primaryEnvironmentId,
    projectId: thread?.projectId ?? draft?.projectId ?? null,
  };
}

const openNotesTab = (threadRef: ReturnType<typeof useRouteNotesContext>["threadRef"]) => {
  if (threadRef) useRightPanelStore.getState().open(threadRef, "notes");
};

export function ForkNotesCaptureDialog() {
  const open = useForkNotesCaptureStore((state) => state.open);
  const prefill = useForkNotesCaptureStore((state) => state.prefill);
  const context = useRouteNotesContext();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { threadRef } = context;

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if ((command !== "notes.capture" && command !== "notes.open") || isCommandPaletteOpen()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "notes.capture") useForkNotesCaptureStore.getState().show(chatSelection());
      else openNotesTab(threadRef);
    };
    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, [keybindings, threadRef]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) useForkNotesCaptureStore.getState().close();
      }}
    >
      {open ? <CaptureForm key={prefill} prefill={prefill} context={context} /> : null}
    </Dialog>
  );
}

function CaptureForm({
  prefill,
  context,
}: {
  prefill: string;
  context: ReturnType<typeof useRouteNotesContext>;
}) {
  const targets = useMemo(
    () =>
      forkNotesTargets({
        threadId: context.threadRef?.threadId ?? null,
        projectId: context.projectId,
      }),
    [context.threadRef?.threadId, context.projectId],
  );
  const panelScope = useForkNotesStore((state) =>
    context.threadRef ? state.scopeByThreadKey[scopedThreadKey(context.threadRef)] : undefined,
  );
  // The scope the thread's Notes tab shows, else the narrowest one there is.
  const initialScope =
    [panelScope ?? "thread", ...FORK_NOTE_SCOPES].find((option) => targets[option] !== null) ??
    "global";
  const [scope, setScope] = useState<ForkNoteScope>(initialScope);
  const [text, setText] = useState(prefill);
  const addAsTodo = useForkNotesStore((state) => state.addAsTodo);
  const [todo, setTodo] = useState(addAsTodo);
  const act = useForkNotesAct(context.environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openShortcut = shortcutLabelForCommand(keybindings, "notes.open");

  const target = targets[scope];
  const save = () => {
    const trimmed = text.trim();
    if (!trimmed || !target) return;
    useForkNotesCaptureStore.getState().close();
    void act({ type: "create", ...target, text: trimmed, todo });
  };

  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>Capture note</DialogTitle>
        <DialogDescription>
          Saved to the Notes tab
          {openShortcut ? (
            <>
              {" "}
              (<Kbd>{openShortcut}</Kbd>)
            </>
          ) : null}
          .
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <ToggleGroup
            className="w-full *:flex-1"
            value={[scope]}
            onValueChange={(next) => {
              const [selected] = next;
              if (selected === "thread" || selected === "project" || selected === "global") {
                setScope(selected);
              }
            }}
          >
            {FORK_NOTE_SCOPES.map((option) => (
              <ToggleGroupItem key={option} value={option} disabled={targets[option] === null}>
                {FORK_NOTE_SCOPE_LABELS[option]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Textarea
            autoFocus
            value={text}
            aria-label={todo ? "Todo" : "Note"}
            placeholder={todo ? "What needs doing?" : "What do you want to keep?"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                save();
              }
            }}
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Toggle
          variant="outline"
          pressed={todo}
          onPressedChange={setTodo}
          aria-label="Save as todo"
        >
          <ListTodoIcon />
          Todo
        </Toggle>
        <Button disabled={!text.trim() || !target} onClick={save}>
          Save
          <Kbd>↵</Kbd>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/** Command palette entries: capture a note, and open the Notes tab of a thread. */
export function forkNotesCommandItems(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): CommandPaletteActionItem[] {
  const capture: CommandPaletteActionItem = {
    kind: "action",
    value: "action:fork-notes-capture",
    searchTerms: ["note", "todo", "capture", "notiz", "aufgabe"],
    title: "Capture note",
    icon: <NotebookPenIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "notes.capture",
    run: async () => useForkNotesCaptureStore.getState().show(""),
  };
  if (!activeThread) return [capture];
  const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
  return [
    capture,
    {
      kind: "action",
      value: "action:fork-notes-open",
      searchTerms: ["notes", "todos", "notizen"],
      title: "Open notes",
      icon: <PencilLineIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "notes.open",
      run: async () => openNotesTab(threadRef),
    },
  ];
}
