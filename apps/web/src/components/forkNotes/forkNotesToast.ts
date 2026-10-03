import { anchoredToastManager, toastManager } from "~/components/ui/toast";

/**
 * Fork: the Notes toasts show at the bottom of the Notes panel, so they do not
 * cover its scope toggle and add field the way the app's top-right toasts do.
 * The panel registers its anchor; without an open panel they fall back to the
 * app's toasts. One at a time: a new one replaces the last.
 */
let anchor: HTMLElement | null = null;
let shown: { readonly id: string; readonly anchored: boolean } | null = null;

/** Ref callback for the element the toasts sit above. */
export const forkNotesToastAnchor = (element: HTMLElement | null) => {
  anchor = element;
};

type ToastOptions = Parameters<typeof toastManager.add>[0];

const close = (toast: { readonly id: string; readonly anchored: boolean }) =>
  (toast.anchored ? anchoredToastManager : toastManager).close(toast.id);

export function showForkNotesToast(options: ToastOptions) {
  if (shown) close(shown);
  const anchored = anchor?.isConnected === true;
  const id = anchored
    ? anchoredToastManager.add({ ...options, positionerProps: { anchor, sideOffset: 12 } })
    : toastManager.add(options);
  shown = { id, anchored };
  return shown;
}

/** A toast with an Undo button that runs `undo`. */
export function toastWithUndo(title: string, undo: () => void) {
  const toast = showForkNotesToast({
    type: "success",
    title,
    timeout: 5000,
    actionProps: {
      children: "Undo",
      onClick: () => {
        close(toast);
        undo();
      },
    },
  });
}
