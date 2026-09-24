import type { ScopedThreadRef } from "@t3tools/contracts";

import { useSplitThreadStore } from "../../splitThreadStore";
import {
  appendRoutePane,
  appendThreadPane,
  findThreadLeaf,
  insertThreadBeside,
  ROUTE_LEAF_ID,
  sameThread,
} from "./splitLayout.logic";

let paneIdCounter = 0;
const nextPaneId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++paneIdCounter}`;

/**
 * Starting a new thread navigates the route pane, which in a split would drop
 * the thread it was showing. Called with that thread once the new thread's
 * navigation landed: it keeps the thread in a pane of its own and gives the
 * new one an appended pane. Outside a split nothing happens — a new thread
 * still just replaces the single view.
 */
export function keepRouteThreadInSplit(thread: ScopedThreadRef | null): void {
  if (!thread) return;
  const { layout, setLayout, setActiveLeaf } = useSplitThreadStore.getState();
  const next = appendRoutePane(layout, thread, nextPaneId);
  if (next === layout) return;
  setLayout(next);
  setActiveLeaf(ROUTE_LEAF_ID);
}

/**
 * Opening a thread from outside the grid — a notification, a deep link — must
 * not hand the route pane to it while other threads are on screen. Focuses and
 * flashes the pane already showing it, or appends one, and reports whether
 * the split handled it; when it did not, the caller navigates as usual.
 */
export function revealThreadInSplit(
  thread: ScopedThreadRef,
  routeThread: ScopedThreadRef | null,
): boolean {
  const { layout, setLayout, setActiveLeaf } = useSplitThreadStore.getState();
  if (layout.kind === "leaf") return false;
  if (routeThread && sameThread(thread, routeThread)) {
    setActiveLeaf(ROUTE_LEAF_ID);
    flashPane(ROUTE_LEAF_ID);
    return true;
  }
  const existing = findThreadLeaf(layout, thread);
  if (existing) {
    setActiveLeaf(existing.id);
    focusPane(existing.id);
    flashPane(existing.id);
    return true;
  }
  const appended = appendThreadPane(layout, thread, nextPaneId);
  if (!appended) return false;
  setLayout(appended.layout);
  setActiveLeaf(appended.leafId);
  focusPane(appended.leafId);
  flashPane(appended.leafId);
  return true;
}

/**
 * Opens a thread in a pane right of the focused one, so it can be read next to
 * the thread in front of the user instead of replacing it. Without a split this
 * starts one; a thread already on screen just takes focus.
 */
export function openThreadBeside(thread: ScopedThreadRef): void {
  const { layout, activeLeafId, routeThread, setLayout, setActiveLeaf } =
    useSplitThreadStore.getState();
  if (routeThread && sameThread(thread, routeThread) && findThreadLeaf(layout, thread) === null) {
    setActiveLeaf(ROUTE_LEAF_ID);
    focusPane(ROUTE_LEAF_ID);
    if (layout.kind !== "leaf") flashPane(ROUTE_LEAF_ID);
    return;
  }
  const next = insertThreadBeside(layout, activeLeafId, thread, nextPaneId);
  if (next.layout !== layout) setLayout(next.layout);
  setActiveLeaf(next.leafId);
  focusPane(next.leafId);
  flashPane(next.leafId);
}

/** Whether a pane of the split already shows this thread. */
export function hasThreadPane(thread: ScopedThreadRef): boolean {
  const { layout } = useSplitThreadStore.getState();
  return layout.kind !== "leaf" && findThreadLeaf(layout, thread) !== null;
}

/**
 * Puts the caret in a pane's composer, so the revealed thread is the one that
 * receives typing. The pane may have just been added, so the focus waits for
 * its composer to mount.
 */
function focusPane(leafId: string): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const editor = document
      .querySelector(`[data-chat-pane="${CSS.escape(leafId)}"]`)
      ?.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    editor?.focus({ preventScroll: true });
  });
}

/**
 * Flashes a pane once, so the eye finds the thread just revealed among the
 * others in a split. A one-shot overlay that removes itself; it never blocks
 * input. The pane may have just been added, so the flash waits for it.
 */
function flashPane(leafId: string): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const pane = document.querySelector<HTMLElement>(`[data-chat-pane="${CSS.escape(leafId)}"]`);
    if (!pane) return;
    pane.querySelector(":scope > [data-pane-flash]")?.remove();
    const overlay = document.createElement("div");
    overlay.dataset.paneFlash = "";
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      zIndex: "50",
      pointerEvents: "none",
      background: "color-mix(in oklab, var(--primary) 14%, transparent)",
      boxShadow: "inset 0 0 0 2px var(--primary)",
      opacity: "0",
    });
    pane.append(overlay);
    const animation = overlay.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }],
      { duration: 900, easing: "ease-out" },
    );
    const remove = () => overlay.remove();
    animation.addEventListener("finish", remove);
    animation.addEventListener("cancel", remove);
  });
}
