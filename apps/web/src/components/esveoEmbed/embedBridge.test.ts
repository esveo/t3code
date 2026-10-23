import { describe, expect, it } from "vite-plus/test";

import {
  type EsveoEmbedMessage,
  installEmbedEscapeForwarding,
  postEmbedReady,
} from "./embedBridge";

type Listener = (event: KeyboardEvent) => void;

function fakeHost({ framed = true, overlay = false, pathname = "/popout/env/thread" } = {}) {
  const posted: EsveoEmbedMessage[] = [];
  const listeners: { listener: Listener; capture: boolean }[] = [];
  const self = {};
  const dom = { overlayOpen: overlay };
  const host = {
    self,
    top: framed ? {} : self,
    parent: { postMessage: (message: EsveoEmbedMessage) => posted.push(message) },
    location: { pathname },
    document: { querySelector: () => (dom.overlayOpen ? {} : null) },
    addEventListener: (_type: "keydown", listener: Listener, capture: boolean) =>
      listeners.push({ listener, capture }),
    removeEventListener: (_type: "keydown", listener: Listener) =>
      listeners.splice(
        listeners.findIndex((entry) => entry.listener === listener),
        1,
      ),
  };
  // Window capture listeners, then the app's own handler, then window bubble listeners.
  const press = (
    init: Partial<KeyboardEvent> = {},
    handle: (event: { preventDefault(): void }) => void = () => {},
  ) => {
    const event = {
      key: "Escape",
      repeat: false,
      isComposing: false,
      keyCode: 27,
      target: { tagName: "DIV" },
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
      ...init,
    } as KeyboardEvent & { defaultPrevented: boolean };
    for (const entry of listeners.filter((entry) => entry.capture)) entry.listener(event);
    handle(event);
    for (const entry of listeners.filter((entry) => !entry.capture)) entry.listener(event);
  };
  return { host, posted, listeners, press, dom };
}

describe("installEmbedEscapeForwarding", () => {
  it("tells the embedder about an Escape nothing handled", () => {
    const { host, posted, press } = fakeHost();
    installEmbedEscapeForwarding(host);
    press();
    expect(posted).toEqual([{ source: "esveo-code", type: "escape" }]);
  });

  it("does nothing when the app is not framed", () => {
    const { host, listeners } = fakeHost({ framed: false });
    installEmbedEscapeForwarding(host);
    expect(listeners).toEqual([]);
  });

  it("keeps an Escape that a handler used, or that closed an overlay", () => {
    const { host, posted, press, dom } = fakeHost({ overlay: true });
    installEmbedEscapeForwarding(host);
    // The overlay unmounts while the key is handled; it was open when the key went down.
    press({}, () => {
      dom.overlayOpen = false;
    });
    press({}, (event) => event.preventDefault());
    expect(posted).toEqual([]);
  });

  it("forwards an Escape that only ProseMirror prevented", () => {
    const { host, posted, press } = fakeHost();
    installEmbedEscapeForwarding(host);
    const editor = { tagName: "DIV", closest: (selectors: string) => (selectors ? {} : null) };
    press({ target: editor as unknown as EventTarget }, (event) => event.preventDefault());
    expect(posted).toEqual([{ source: "esveo-code", type: "escape" }]);
  });

  it("ignores repeats, IME composition, other keys and form fields", () => {
    const { host, posted, press } = fakeHost();
    installEmbedEscapeForwarding(host);
    press({ repeat: true });
    press({ isComposing: true });
    press({ keyCode: 229 });
    press({ key: "Enter" });
    press({ target: { tagName: "INPUT" } as unknown as EventTarget });
    expect(posted).toEqual([]);
  });

  it("stops forwarding once uninstalled", () => {
    const { host, listeners } = fakeHost();
    installEmbedEscapeForwarding(host)();
    expect(listeners).toEqual([]);
  });
});

describe("postEmbedReady", () => {
  it("posts the mounted path once", () => {
    const { host, posted } = fakeHost({ pathname: "/" });
    postEmbedReady(host);
    postEmbedReady(host);
    expect(posted).toEqual([{ source: "esveo-code", type: "ready", path: "/" }]);
  });

  it("stays quiet when the app is not framed", () => {
    const { host, posted } = fakeHost({ framed: false });
    postEmbedReady(host);
    expect(posted).toEqual([]);
  });
});
