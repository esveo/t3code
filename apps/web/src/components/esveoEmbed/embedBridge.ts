import { useEffect } from "react";

/**
 * Messages esveo code posts to the page that embeds it in an iframe, such as
 * esveo-island. They carry nothing private, so they go to any origin:
 *
 * - `escape`: Escape was pressed and nothing in the app used it. Keydowns in a
 *   cross-origin iframe never reach the embedding page, so it cannot see the
 *   key itself.
 * - `ready`: the signed-in app has mounted at `path`. After pairing the app
 *   reloads at `/`, so an embedder that wants a thread loads its popout URL
 *   again when `path` is not that URL.
 *
 * Nothing is posted when the app is not framed.
 */
export type EsveoEmbedMessage =
  | { source: "esveo-code"; type: "escape" }
  | { source: "esveo-code"; type: "ready"; path: string };

interface EmbedHost {
  readonly self: unknown;
  readonly top: unknown;
  readonly parent: { postMessage(message: EsveoEmbedMessage, targetOrigin: string): void };
  readonly location: { readonly pathname: string };
  readonly document: { querySelector(selectors: string): unknown };
  addEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    capture: boolean,
  ): void;
}

// Closing one of these with Escape must not also leave the embedder's view.
// Thread find is a `search` landmark rather than a dialog.
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="search"]';

const isFramed = (host: EmbedHost) => host.self !== host.top;

export function installEmbedEscapeForwarding(host: EmbedHost): () => void {
  if (!isFramed(host)) return () => {};
  // Read before anyone handles the key: a menu closed by this Escape may
  // already be unmounted by the time the event bubbles back to the window.
  let overlayOpen = false;
  const recordOverlay = (event: KeyboardEvent) => {
    if (event.key === "Escape") overlayOpen = host.document.querySelector(OVERLAY_SELECTOR) != null;
  };
  const forward = (event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      (event.defaultPrevented && !isInProseMirror(event.target)) ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      overlayOpen ||
      isFormField(event.target)
    )
      return;
    host.parent.postMessage({ source: "esveo-code", type: "escape" }, "*");
  };
  host.addEventListener("keydown", recordOverlay, true);
  host.addEventListener("keydown", forward, false);
  return () => {
    host.removeEventListener("keydown", recordOverlay, true);
    host.removeEventListener("keydown", forward, false);
  };
}

// ProseMirror, the composer's editor, prevents the default of every Escape,
// used or not. When the composer does use one (closing its menu), it also
// stops propagation, so that Escape never reaches the window.
function isInProseMirror(target: EventTarget | null) {
  const closest = (target as { closest?: (selectors: string) => unknown } | null)?.closest;
  return typeof closest === "function" && closest.call(target, ".ProseMirror") != null;
}

// Escape in a text field cancels its edit (renaming a thread, for one), often
// without preventDefault. The composer is contenteditable, so it still forwards.
function isFormField(target: EventTarget | null) {
  const tagName = (target as { tagName?: unknown } | null)?.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

// Once per page load, however often the root re-renders or remounts.
const readyPosted = new WeakSet<EmbedHost>();

export function postEmbedReady(host: EmbedHost) {
  if (readyPosted.has(host) || !isFramed(host)) return;
  readyPosted.add(host);
  host.parent.postMessage(
    { source: "esveo-code", type: "ready", path: host.location.pathname },
    "*",
  );
}

export function useEsveoEmbedBridge(authenticated: boolean) {
  useEffect(() => installEmbedEscapeForwarding(window), []);
  useEffect(() => {
    if (authenticated) postEmbedReady(window);
  }, [authenticated]);
}
