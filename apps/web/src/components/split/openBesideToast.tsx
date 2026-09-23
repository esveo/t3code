import type { ScopedThreadRef } from "@t3tools/contracts";

import { isMacPlatform } from "../../lib/utils";
import { Kbd } from "../ui/kbd";
import type { ThreadToastData } from "../ui/toast";
import { openThreadBeside } from "./splitPanes";

/**
 * "Open in new pane" on thread notification toasts: a second toast button, plus
 * ⌥⌘O / Ctrl+Alt+O while the toast is visible, that opens the thread in a pane
 * next to the focused one. With several toasts up the shortcut acts on the
 * newest.
 */

interface ArmedToast {
  readonly open: () => void;
}

const armed: ArmedToast[] = [];
let listening = false;

function isOpenBesideShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyO" || !event.altKey || event.shiftKey || event.repeat) return false;
  return isMacPlatform(navigator.platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

function onKeyDown(event: KeyboardEvent): void {
  const target = armed.at(-1);
  if (!target || !isOpenBesideShortcut(event)) return;
  event.preventDefault();
  event.stopPropagation();
  target.open();
}

function shortcutLabel(): string {
  return isMacPlatform(navigator.platform) ? "⌥⌘O" : "Ctrl+Alt+O";
}

/**
 * Builds the toast's "Open in new pane" button and arms the shortcut for it. Pass
 * `disarm` as the toast's `onClose`, so the shortcut ends with the toast.
 */
export function openBesideToastAction(thread: ScopedThreadRef, closeToast: () => void) {
  const entry: ArmedToast = {
    open: () => {
      closeToast();
      openThreadBeside(thread);
    },
  };
  armed.push(entry);
  if (!listening) {
    listening = true;
    window.addEventListener("keydown", onKeyDown, { capture: true });
  }
  return {
    /** Spread into the toast's `data`. Two buttons leave the text too little
     * room beside them, so they move to a row of their own. */
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: {
        children: (
          <>
            Open in new pane
            <Kbd>{shortcutLabel()}</Kbd>
          </>
        ),
        onClick: entry.open,
      },
    } satisfies ThreadToastData,
    disarm: () => {
      const index = armed.indexOf(entry);
      if (index !== -1) armed.splice(index, 1);
    },
  };
}
