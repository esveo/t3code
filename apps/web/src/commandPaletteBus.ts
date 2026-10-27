import type {
  EnvironmentId,
  PullRequestLinkedThreadsResult,
  ScopedProjectRef,
} from "@t3tools/contracts";

import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /**
   * With `open: "new-thread-in"`: receive the picked project instead of the
   * palette starting a new thread in it.
   */
  readonly onProjectPicked?: (projectRef: ScopedProjectRef) => void;
}

let pendingProjectPick: ((projectRef: ScopedProjectRef) => void) | null = null;

/** The palette hands a picked project to the caller that asked for it, once. */
export function takePendingProjectPick(): ((projectRef: ScopedProjectRef) => void) | null {
  const pick = pendingProjectPick;
  pendingProjectPick = null;
  return pick;
}

export function clearPendingProjectPick(): void {
  pendingProjectPick = null;
}

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  pendingProjectPick = detail.onProjectPicked ?? null;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({ _tag: "OpenAddProject" });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
