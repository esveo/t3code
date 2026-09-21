import { describe, expect, it } from "vite-plus/test";

import { resolveForkServiceVersions, resolveForkUpdateLabel } from "./ForkAppUpdates.ts";

const running = "0.0.43-fork.origin-fork.aaaaaaa";
const built = "0.0.44-fork.origin-fork.bbbbbbb";

describe("resolveForkServiceVersions", () => {
  it("has nothing pending when the service runs the newest server", () => {
    expect(
      resolveForkServiceVersions({
        activeVersion: running,
        previousVersion: null,
        restartPending: false,
        builtVersion: running,
      }),
    ).toEqual({ runningVersion: running, pendingVersion: null });
  });

  it("offers a newer server the service does not run yet", () => {
    expect(
      resolveForkServiceVersions({
        activeVersion: running,
        previousVersion: null,
        restartPending: false,
        builtVersion: built,
      }),
    ).toEqual({ runningVersion: running, pendingVersion: built });
  });

  it("keeps offering a switch whose restart has not happened", () => {
    expect(
      resolveForkServiceVersions({
        activeVersion: built,
        previousVersion: running,
        restartPending: true,
        builtVersion: built,
      }),
    ).toEqual({ runningVersion: running, pendingVersion: built });
  });

  it("has nothing pending before the first fork server is built", () => {
    expect(
      resolveForkServiceVersions({
        activeVersion: "0.0.42",
        previousVersion: null,
        restartPending: false,
        builtVersion: null,
      }),
    ).toEqual({ runningVersion: "0.0.42", pendingVersion: null });
  });
});

describe("resolveForkUpdateLabel", () => {
  const idleService = { pendingVersion: null, blockedReason: null };

  it("offers the prepared app, which the update installs with any pending server", () => {
    expect(
      resolveForkUpdateLabel({
        preparedApp: "fork@ccccccc",
        service: { pendingVersion: built, blockedReason: null },
      }),
    ).toBe("fork@ccccccc");
  });

  it("offers a pending server on its own", () => {
    expect(
      resolveForkUpdateLabel({
        preparedApp: null,
        service: { pendingVersion: built, blockedReason: null },
      }),
    ).toBe(built);
  });

  it("offers nothing for a blocked server or when nothing waits", () => {
    expect(
      resolveForkUpdateLabel({
        preparedApp: null,
        service: { pendingVersion: built, blockedReason: "needs a newer launcher" },
      }),
    ).toBeNull();
    expect(resolveForkUpdateLabel({ preparedApp: null, service: idleService })).toBeNull();
  });
});
