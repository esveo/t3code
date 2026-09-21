// Private fork: the app and the t3 service update together through one button.
// See apps/desktop/src/updates/ForkAppUpdates.ts.
import type { DesktopUpdateState } from "@t3tools/contracts";

/** Fork builds report the service beside the app; the regular updater never does. */
export function isForkUpdateState(state: DesktopUpdateState | null): boolean {
  return state?.forkService !== undefined;
}

export function getForkUpdateTooltip(state: DesktopUpdateState): string {
  return `${state.downloadedVersion ?? "Update"} is ready. Click to restart and update.`;
}
