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

/** Gigabytes with one decimal; every build is gigabytes, so smaller units would mislead. */
export function formatForkBuildSize(sizeBytes: number): string {
  return `${(sizeBytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The second line of a build's row: commit, whether it holds uncommitted changes, time and size. */
export function describeForkBuild(build: DesktopForkBuild, now: Date = new Date()): string {
  const parts = [`${build.commit.slice(0, 7)}${build.dirty ? "+changes" : ""}`];
  const time = formatForkBuildTime(build.builtAt, now);
  if (time !== "") parts.push(time);
  if (build.sizeBytes !== null) parts.push(formatForkBuildSize(build.sizeBytes));
  if (build.serverBlocked !== null) parts.push("server blocked");
  else if (build.serverVersion !== null) parts.push("with server");
  return parts.join(" · ");
}

/** Counts the waiting builds and what they take on disk, so deleting stale ones stays tempting. */
export function getForkUpdateTooltip(state: DesktopUpdateState): string {
  const builds = state.forkBuilds ?? [];
  if (builds.length === 0) {
    return state.forkService?.pendingVersion !== null &&
      state.forkService?.pendingVersion !== undefined
      ? "Service restart pending"
      : "Check for updates";
  }
  const total = builds.reduce((sum, build) => sum + (build.sizeBytes ?? 0), 0);
  const count = builds.length === 1 ? "1 build ready" : `${builds.length} builds ready`;
  return total > 0 ? `${count} · ${formatForkBuildSize(total)} on disk` : count;
}
