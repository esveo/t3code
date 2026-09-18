import type { DesktopBridge } from "@t3tools/contracts";

/**
 * Cmd+V in the desktop app is the Edit menu's paste role, which Chromium runs
 * as an editing command rather than delivering to the page. With no editable
 * element focused the command applies to nothing and, unlike a browser, no
 * paste event is dispatched at all: paste-to-focus never sees the clipboard
 * and the keystroke is silently lost.
 *
 * The keydown still arrives, so this waits one turn for a paste event and,
 * when none came, asks the desktop shell for the clipboard text and hands it
 * to the composer. Waiting for the event rather than predicting Chromium's
 * rule is what keeps a paste that did land from being inserted twice.
 */
export interface DesktopClipboardPasteOptions {
  readonly bridge: Pick<DesktopBridge, "readClipboardText"> | undefined;
  readonly target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly macPlatform: boolean;
  /** Whether this paste belongs to the composer, checked when the key lands. */
  readonly shouldHandle: (event: KeyboardEvent) => boolean;
  readonly insertText: (text: string, options: { bypassAutoAttachment: boolean }) => void;
  /** Injected in tests; defaults to a macrotask so a real paste wins the race. */
  readonly schedule?: (run: () => void) => void;
}

/** The paste chords, and whether the user asked for unformatted text. */
export function clipboardPasteShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  macPlatform: boolean,
): { bypassAutoAttachment: boolean } | null {
  if (event.key.toLowerCase() !== "v" || event.altKey) return null;
  const chord = macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return chord ? { bypassAutoAttachment: event.shiftKey } : null;
}

export function installDesktopClipboardPasteFallback(
  options: DesktopClipboardPasteOptions,
): () => void {
  const readClipboardText = options.bridge?.readClipboardText;
  if (!readClipboardText) return () => {};
  const schedule = options.schedule ?? ((run: () => void) => void setTimeout(run, 0));

  let pending: { bypassAutoAttachment: boolean } | null = null;

  const onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    const shortcut = clipboardPasteShortcut(keyboardEvent, options.macPlatform);
    if (!shortcut || !options.shouldHandle(keyboardEvent)) return;
    pending = shortcut;
    schedule(() => {
      const claimed = pending;
      pending = null;
      if (!claimed) return;
      void readClipboardText().then((text) => {
        if (text) options.insertText(text, { bypassAutoAttachment: claimed.bypassAutoAttachment });
      });
    });
  };

  // Chromium delivered the clipboard after all, so the page handles it.
  const onPaste = () => {
    pending = null;
  };

  options.target.addEventListener("keydown", onKeyDown, true);
  options.target.addEventListener("paste", onPaste, true);
  return () => {
    options.target.removeEventListener("keydown", onKeyDown, true);
    options.target.removeEventListener("paste", onPaste, true);
  };
}
