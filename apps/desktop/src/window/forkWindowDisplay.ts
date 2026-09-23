// Fork: keeps a maximized window on its display across restarts.
//
// A maximized window persists its normal (restore) bounds. On macOS those can
// be stale: a window zoomed or resized to fill an external display still
// reports the default-sized frame on the primary display it opened on, so the
// next launch maximizes it there instead.
import * as Electron from "electron";

type Rect = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function displayContainingCenter(rect: Rect, displays: readonly Rect[]): Rect | undefined {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  return displays.find(
    (display) =>
      x >= display.x &&
      x < display.x + display.width &&
      y >= display.y &&
      y < display.y + display.height,
  );
}

/** Moves the normal bounds, centered, onto the display the window is on now. */
export function keepNormalBoundsOnWindowDisplay(
  normal: Rect,
  current: Rect,
  displays: readonly Rect[],
): Rect {
  const target = displayContainingCenter(current, displays);
  if (target === undefined || target === displayContainingCenter(normal, displays)) {
    return normal;
  }
  const width = Math.min(normal.width, target.width);
  const height = Math.min(normal.height, target.height);
  return {
    x: target.x + Math.round((target.width - width) / 2),
    y: target.y + Math.round((target.height - height) / 2),
    width,
    height,
  };
}

/** The normal bounds of a maximized, fullscreen or minimized window, as worth persisting. */
export function readForkNormalBounds(window: Electron.BrowserWindow): Rect {
  const normal = window.getNormalBounds();
  if (!window.isMaximized() || window.isFullScreen() || window.isMinimized()) {
    return normal;
  }
  try {
    const displays = Electron.screen.getAllDisplays().map((display) => display.bounds);
    return keepNormalBoundsOnWindowDisplay(normal, window.getBounds(), displays);
  } catch {
    return normal;
  }
}
