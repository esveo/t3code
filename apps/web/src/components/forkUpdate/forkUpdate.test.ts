import { describe, expect, it } from "vite-plus/test";

import type { DesktopForkBuild } from "@t3tools/contracts";
import { describeForkBuild, formatForkBuildTime, getForkUpdateTooltip } from "./forkUpdate";

const now = new Date("2026-09-22T12:00:00");

const build: DesktopForkBuild = {
  branch: "feat/x",
  slug: "feat-x",
  label: "feat/x@abcdef0 10:00",
  commit: "abcdef0123456789",
  builtAt: "2026-09-22T08:00:00",
  dirty: false,
  serverVersion: null,
  serverBlocked: null,
};

describe("formatForkBuildTime", () => {
  it("shows only the clock time for today's builds", () => {
    expect(formatForkBuildTime("2026-09-22T08:05:00", now)).toBe(
      new Date("2026-09-22T08:05:00").toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });

  it("adds the date for older builds and drops unparsable times", () => {
    expect(formatForkBuildTime("2026-09-20T08:05:00", now)).toMatch(/20/);
    expect(formatForkBuildTime("", now)).toBe("");
  });
});

describe("describeForkBuild", () => {
  it("names the short commit, uncommitted changes and the server it brings", () => {
    expect(describeForkBuild(build, now)).toMatch(/^abcdef0 · /);
    expect(describeForkBuild({ ...build, dirty: true }, now)).toMatch(/^abcdef0\+changes · /);
    expect(
      describeForkBuild({ ...build, serverVersion: "0.0.44-fork.feat-x.abcdef0" }, now),
    ).toMatch(/ · with server$/);
    expect(describeForkBuild({ ...build, serverBlocked: "needs a launcher" }, now)).toMatch(
      / · server blocked$/,
    );
  });
});

describe("getForkUpdateTooltip", () => {
  const base = {
    forkService: { runningVersion: "0.0.43", pendingVersion: null, blockedReason: null },
  };

  it("counts the waiting builds", () => {
    expect(getForkUpdateTooltip({ ...base, forkBuilds: [] } as never)).toBe("Check for updates");
    expect(getForkUpdateTooltip({ ...base, forkBuilds: [build] } as never)).toBe("1 build ready");
    expect(getForkUpdateTooltip({ ...base, forkBuilds: [build, build] } as never)).toBe(
      "2 builds ready",
    );
  });

  it("names a service restart that is still pending", () => {
    expect(
      getForkUpdateTooltip({
        forkService: { runningVersion: "0.0.43", pendingVersion: "0.0.44", blockedReason: null },
        forkBuilds: [],
      } as never),
    ).toBe("Service restart pending");
  });
});
