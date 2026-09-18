import { describe, expect, it } from "vite-plus/test";

import {
  clipboardPasteShortcut,
  installDesktopClipboardPasteFallback,
} from "./desktopClipboardPaste";

function makeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    target: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener);
      },
    } as unknown as Pick<EventTarget, "addEventListener" | "removeEventListener">,
    dispatch: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const pasteKey = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    key: "v",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }) as KeyboardEvent;

function setup(options?: { shouldHandle?: (event: KeyboardEvent) => boolean; clipboard?: string }) {
  const harness = makeTarget();
  const inserted: Array<{ text: string; bypassAutoAttachment: boolean }> = [];
  const scheduled: Array<() => void> = [];
  const uninstall = installDesktopClipboardPasteFallback({
    bridge: { readClipboardText: () => Promise.resolve(options?.clipboard ?? "CLIP") },
    target: harness.target,
    macPlatform: true,
    shouldHandle: options?.shouldHandle ?? (() => true),
    insertText: (text, opts) => inserted.push({ text, ...opts }),
    schedule: (run) => scheduled.push(run),
  });
  const flush = async () => {
    for (const run of scheduled.splice(0)) run();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { ...harness, inserted, flush, uninstall };
}

describe("clipboardPasteShortcut", () => {
  it("claims the paste chords and reports plain-text intent", () => {
    expect(clipboardPasteShortcut(pasteKey(), true)).toEqual({ bypassAutoAttachment: false });
    expect(clipboardPasteShortcut(pasteKey({ shiftKey: true }), true)).toEqual({
      bypassAutoAttachment: true,
    });
  });

  it("ignores other keys and platform-foreign chords", () => {
    expect(clipboardPasteShortcut(pasteKey({ key: "c" }), true)).toBeNull();
    expect(clipboardPasteShortcut(pasteKey({ altKey: true }), true)).toBeNull();
    expect(clipboardPasteShortcut(pasteKey(), false)).toBeNull();
    expect(clipboardPasteShortcut(pasteKey({ metaKey: false, ctrlKey: true }), false)).toEqual({
      bypassAutoAttachment: false,
    });
  });
});

describe("installDesktopClipboardPasteFallback", () => {
  it("inserts the clipboard when Chromium dispatched no paste event", async () => {
    const harness = setup();
    harness.dispatch("keydown", pasteKey());
    await harness.flush();
    expect(harness.inserted).toEqual([{ text: "CLIP", bypassAutoAttachment: false }]);
  });

  it("stands down when the paste event arrived, so nothing is inserted twice", async () => {
    const harness = setup();
    harness.dispatch("keydown", pasteKey());
    harness.dispatch("paste", {});
    await harness.flush();
    expect(harness.inserted).toEqual([]);
  });

  it("carries plain-text intent from the shift chord", async () => {
    const harness = setup();
    harness.dispatch("keydown", pasteKey({ shiftKey: true }));
    await harness.flush();
    expect(harness.inserted).toEqual([{ text: "CLIP", bypassAutoAttachment: true }]);
  });

  it("leaves the keystroke alone when the composer declines it", async () => {
    const harness = setup({ shouldHandle: () => false });
    harness.dispatch("keydown", pasteKey());
    await harness.flush();
    expect(harness.inserted).toEqual([]);
  });

  it("inserts nothing when the clipboard holds no text", async () => {
    const harness = setup({ clipboard: "" });
    harness.dispatch("keydown", pasteKey());
    await harness.flush();
    expect(harness.inserted).toEqual([]);
  });

  it("installs nothing without a desktop shell that can read the clipboard", () => {
    const harness = makeTarget();
    const uninstall = installDesktopClipboardPasteFallback({
      bridge: undefined,
      target: harness.target,
      macPlatform: true,
      shouldHandle: () => true,
      insertText: () => {},
    });
    expect(harness.count("keydown")).toBe(0);
    uninstall();
  });

  it("removes its listeners on uninstall", () => {
    const harness = setup();
    harness.uninstall();
    expect(harness.count("keydown")).toBe(0);
    expect(harness.count("paste")).toBe(0);
  });
});
