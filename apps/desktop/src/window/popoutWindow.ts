import type * as Electron from "electron";

/**
 * Thread popouts (see apps/web/src/components/split/threadPopout.ts) are the
 * one same-origin `window.open` the renderer is allowed to make: every other
 * popup is still denied and, when it is a safe external link, handed to the
 * system browser.
 *
 * A popout keeps the ordinary native frame rather than the main window's
 * custom titlebar, so the OS draws its title (the thread's) and its controls.
 */

const POPOUT_PATH_PREFIX = "/popout/";
const DEFAULT_POPOUT_WIDTH = 900;
const DEFAULT_POPOUT_HEIGHT = 760;
const MINIMUM_POPOUT_WIDTH = 520;
const MINIMUM_POPOUT_HEIGHT = 480;

/**
 * The app's route inside a URL. The desktop renderer routes through the hash
 * (`t3code://app/#/popout/...`); a browser build uses the path.
 */
function routeOf(url: URL): string {
  return url.hash.startsWith("#/") ? url.hash.slice(1) : url.pathname;
}

export function isThreadPopoutUrl(input: {
  readonly applicationUrl: string;
  readonly targetUrl: string;
}): boolean {
  try {
    const application = new URL(input.applicationUrl);
    const target = new URL(input.targetUrl);
    // Custom schemes have an opaque origin ("null" for every one of them), so
    // scheme and host are compared as well: without that, t3code-dev:// or
    // another host would read as the application itself.
    if (
      application.origin !== target.origin ||
      application.protocol !== target.protocol ||
      application.host !== target.host
    ) {
      return false;
    }
    return routeOf(target).startsWith(POPOUT_PATH_PREFIX);
  } catch {
    return false;
  }
}

/** Reads one numeric entry out of a `window.open` features string. */
function readFeature(features: string, name: string): number | null {
  for (const entry of features.split(",")) {
    const [key, value] = entry.split("=");
    if (key?.trim() !== name) continue;
    const parsed = Number.parseInt(value?.trim() ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function resolvePopoutWindowOptions(input: {
  readonly features: string;
  readonly backgroundColor: string;
  readonly preloadPath: string;
  readonly title: string;
}): Electron.BrowserWindowConstructorOptions {
  const width = readFeature(input.features, "width") ?? DEFAULT_POPOUT_WIDTH;
  const height = readFeature(input.features, "height") ?? DEFAULT_POPOUT_HEIGHT;
  const left = readFeature(input.features, "left");
  const top = readFeature(input.features, "top");
  return {
    width: Math.max(width, MINIMUM_POPOUT_WIDTH),
    height: Math.max(height, MINIMUM_POPOUT_HEIGHT),
    ...(left === null ? {} : { x: left }),
    ...(top === null ? {} : { y: top }),
    minWidth: MINIMUM_POPOUT_WIDTH,
    minHeight: MINIMUM_POPOUT_HEIGHT,
    autoHideMenuBar: true,
    backgroundColor: input.backgroundColor,
    title: input.title,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  };
}
