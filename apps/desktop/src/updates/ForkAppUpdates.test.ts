import { describe, expect, it } from "vite-plus/test";

import {
  resolveForkBuildServer,
  resolveForkServiceVersions,
  resolveForkUpdateOffer,
  sortForkBuilds,
} from "./ForkAppUpdates.ts";

const running = "0.0.43-fork.fork.aaaaaaa";
const built = "0.0.44-fork.fork.bbbbbbb";

describe("resolveForkServiceVersions", () => {
  it("has nothing pending when the service runs what it was switched to", () => {
    expect(
      resolveForkServiceVersions({
        activeVersion: running,
        previousVersion: null,
        restartPending: false,
      }),
    ).toEqual({ runningVersion: running, pendingVersion: null });
  });

  it("keeps offering a switch whose restart has not happened", () => {
    expect(
      resolveForkServiceVersions({
        activeVersion: built,
        previousVersion: running,
        restartPending: true,
      }),
    ).toEqual({ runningVersion: running, pendingVersion: built });
  });
});

describe("resolveForkBuildServer", () => {
  it("brings no server when the branch built none or the service runs it already", () => {
    expect(
      resolveForkBuildServer({
        builtVersion: null,
        blockedReason: null,
        activeVersion: running,
        restartPending: false,
      }),
    ).toEqual({ serverVersion: null, serverBlocked: null });
    expect(
      resolveForkBuildServer({
        builtVersion: running,
        blockedReason: null,
        activeVersion: running,
        restartPending: false,
      }),
    ).toEqual({ serverVersion: null, serverBlocked: null });
  });

  it("brings the branch's server when the service does not run it yet", () => {
    expect(
      resolveForkBuildServer({
        builtVersion: built,
        blockedReason: null,
        activeVersion: running,
        restartPending: false,
      }),
    ).toEqual({ serverVersion: built, serverBlocked: null });
  });

  it("brings the server again while its restart is still pending", () => {
    expect(
      resolveForkBuildServer({
        builtVersion: built,
        blockedReason: null,
        activeVersion: built,
        restartPending: true,
      }),
    ).toEqual({ serverVersion: built, serverBlocked: null });
  });

  it("reports a blocked server instead of switching to it", () => {
    expect(
      resolveForkBuildServer({
        builtVersion: built,
        blockedReason: "needs a newer launcher",
        activeVersion: running,
        restartPending: false,
      }),
    ).toEqual({ serverVersion: null, serverBlocked: "needs a newer launcher" });
  });
});

const build = (slug: string, builtAt: string) => ({
  slug,
  branch: slug,
  label: `${slug}@1234567 10:00`,
  commit: "1234567",
  builtAt,
  dirty: false,
  serverVersion: null,
  serverBlocked: null,
});

describe("sortForkBuilds", () => {
  it("leads with the fork branch, then newest first", () => {
    const sorted = sortForkBuilds([
      build("feat-old", "2026-09-20T10:00:00Z"),
      build("feat-new", "2026-09-22T10:00:00Z"),
      build("fork", "2026-09-21T10:00:00Z"),
    ]);
    expect(sorted.map((entry) => entry.slug)).toEqual(["fork", "feat-new", "feat-old"]);
  });
});

describe("resolveForkUpdateOffer", () => {
  const idleService = { pendingVersion: null, blockedReason: null };

  it("offers the leading build", () => {
    const fork = build("fork", "2026-09-21T10:00:00Z");
    expect(
      resolveForkUpdateOffer({
        builds: [build("feat-new", "2026-09-22T10:00:00Z"), fork],
        service: idleService,
      }),
    ).toEqual({ label: fork.label, build: fork });
  });

  it("offers a pending service restart when no build waits", () => {
    expect(
      resolveForkUpdateOffer({
        builds: [],
        service: { pendingVersion: built, blockedReason: null },
      }),
    ).toEqual({ label: built, build: null });
  });

  it("offers nothing for a blocked server or when nothing waits", () => {
    expect(
      resolveForkUpdateOffer({
        builds: [],
        service: { pendingVersion: built, blockedReason: "needs a newer launcher" },
      }),
    ).toBeNull();
    expect(resolveForkUpdateOffer({ builds: [], service: idleService })).toBeNull();
  });
});
