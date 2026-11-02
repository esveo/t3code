import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { isElectron } from "../../env";

/** Opens one browser or desktop popout per thread using the hash-routed popout URL. */

const POPOUT_WIDTH = 900;
const POPOUT_HEIGHT = 760;
/** Offset from the opener, so a popout never lands exactly on it. */
const POPOUT_OFFSET = 48;

/** Whether a location belongs to a popped-out thread window. */
export function isPopoutPathname(pathname: string): boolean {
  return pathname.startsWith("/popout/");
}

export function popoutPathForThread(thread: ScopedThreadRef): string {
  return `/popout/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
}

const POPOUT_WINDOW_NAME_PREFIX = "t3code-popout:";

function popoutWindowName(thread: ScopedThreadRef): string {
  return `${POPOUT_WINDOW_NAME_PREFIX}${scopedThreadKey(thread)}`;
}

/**
 * Whether this document runs in a popout window. The window keeps the name it
 * was opened under, so a popout stays recognizable after it navigates — it
 * shows a thread, never the app shell.
 */
export function isPopoutWindow(): boolean {
  return typeof window !== "undefined" && window.name.startsWith(POPOUT_WINDOW_NAME_PREFIX);
}

export function popoutWindowFeatures(opener: {
  readonly screenX: number;
  readonly screenY: number;
}): string {
  return [
    "popup=yes",
    `width=${POPOUT_WIDTH}`,
    `height=${POPOUT_HEIGHT}`,
    `left=${Math.round(opener.screenX) + POPOUT_OFFSET}`,
    `top=${Math.round(opener.screenY) + POPOUT_OFFSET}`,
  ].join(",");
}

/** Windows this document opened, so a repeat popout can focus instead of duplicate. */
const openPopouts = new Map<string, Window>();

export interface ThreadPopoutHost {
  readonly open: (url: string, target: string, features: string) => Window | null;
  readonly screenX: number;
  readonly screenY: number;
  readonly origin: string;
  /** Whether the app's router reads its route from the URL hash. */
  readonly hashRouting: boolean;
}

function browserHost(): ThreadPopoutHost {
  return {
    open: (url, target, features) => window.open(url, target, features),
    screenX: window.screenX,
    screenY: window.screenY,
    origin: window.location.origin,
    hashRouting: isElectron,
  };
}

/** The address of a thread's popout, in the form this app's router reads. */
function popoutUrl(thread: ScopedThreadRef, host: ThreadPopoutHost): string {
  const route = popoutPathForThread(thread);
  return host.hashRouting ? `${host.origin}/#${route}` : `${host.origin}${route}`;
}

/**
 * Opens (or re-focuses) the window showing this thread. Returns false when the
 * browser refused to open one, so the caller can keep the pane where it is.
 */
export function openThreadPopout(
  thread: ScopedThreadRef,
  host: ThreadPopoutHost = browserHost(),
): boolean {
  const name = popoutWindowName(thread);
  const existing = openPopouts.get(name);
  if (existing && !existing.closed) {
    existing.focus();
    return true;
  }
  openPopouts.delete(name);

  const opened = host.open(popoutUrl(thread, host), name, popoutWindowFeatures(host));
  if (!opened) return false;
  openPopouts.set(name, opened);
  opened.focus();
  return true;
}
