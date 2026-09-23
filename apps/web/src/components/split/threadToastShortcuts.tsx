import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { isMacPlatform } from "../../lib/utils";
import { Kbd } from "../ui/kbd";
import type { ThreadToastData } from "../ui/toast";
import { openThreadBeside } from "./splitPanes";

/**
 * Keyboard access for thread notification toasts: "Open thread" answers to
 * ⌥⌘T / Ctrl+Alt+T, and a second button, "Open in new pane", to ⌥⌘O /
 * Ctrl+Alt+O, opening the thread in a pane next to the focused one. The
 * shortcuts live as long as the toast; with several toasts up they act on the
 * newest.
 */

interface ArmedToast {
  openThread: () => void;
  readonly openBeside: () => void;
}

const armed: ArmedToast[] = [];
let listening = false;

const isMac = () => isMacPlatform(navigator.platform);

function matchesShortcut(event: KeyboardEvent, code: string): boolean {
  if (event.code !== code || !event.altKey || event.shiftKey || event.repeat) return false;
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function onKeyDown(event: KeyboardEvent): void {
  const target = armed.at(-1);
  if (!target) return;
  const run = matchesShortcut(event, "KeyT")
    ? target.openThread
    : matchesShortcut(event, "KeyO")
      ? target.openBeside
      : null;
  if (!run) return;
  event.preventDefault();
  event.stopPropagation();
  run();
}

function withShortcut(label: ReactNode, key: string): ReactNode {
  return (
    <>
      {label}
      <Kbd>{isMac() ? `⌥⌘${key}` : `Ctrl+Alt+${key}`}</Kbd>
    </>
  );
}

/**
 * Arms the shortcuts for one toast. Spread `data` into the toast's data, wrap
 * its "Open thread" props in `openThread`, and pass `disarm` as its `onClose`.
 */
export function threadToastShortcuts(thread: ScopedThreadRef, closeToast: () => void) {
  const entry: ArmedToast = {
    openThread: () => {},
    openBeside: () => {
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
    /** Two buttons leave the text too little room beside them, so they move to
     * a row of their own. */
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: {
        children: withShortcut("Open in new pane", "O"),
        onClick: entry.openBeside,
      },
    } satisfies ThreadToastData,
    openThread: (props: { readonly children: ReactNode; readonly onClick: () => void }) => {
      entry.openThread = props.onClick;
      return { ...props, children: withShortcut(props.children, "T") };
    },
    disarm: () => {
      const index = armed.indexOf(entry);
      if (index !== -1) armed.splice(index, 1);
    },
  };
}
