// Private fork: the app and the t3 service update together through one
// drop-up menu that offers every branch's waiting build.
// See apps/desktop/src/updates/ForkAppUpdates.ts.
import type { DesktopForkBuild, DesktopUpdateState } from "@t3tools/contracts";

/** Fork builds report the service beside the app; the regular updater never does. */
export function isForkUpdateState(
  state: DesktopUpdateState | null,
): state is DesktopUpdateState & { forkService: NonNullable<DesktopUpdateState["forkService"]> } {
  return state?.forkService !== undefined;
}

/** A build's time as a clock time, with the date when it is not today's. */
export function formatForkBuildTime(builtAt: string, now: Date = new Date()): string {
  const date = new Date(builtAt);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** The second line of a build's row: commit, whether it holds uncommitted changes, and time. */
export function describeForkBuild(build: DesktopForkBuild, now: Date = new Date()): string {
  const parts = [`${build.commit.slice(0, 7)}${build.dirty ? "+changes" : ""}`];
  const time = formatForkBuildTime(build.builtAt, now);
  if (time !== "") parts.push(time);
  if (build.serverBlocked !== null) parts.push("server blocked");
  else if (build.serverVersion !== null) parts.push("with server");
  return parts.join(" · ");
}

export function getForkUpdateTooltip(state: DesktopUpdateState): string {
  const count = state.forkBuilds?.length ?? 0;
  if (count === 0) {
    return state.forkService?.pendingVersion !== null &&
      state.forkService?.pendingVersion !== undefined
      ? "Service restart pending"
      : "Check for updates";
  }
  return count === 1 ? "1 build ready" : `${count} builds ready`;
}
