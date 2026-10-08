import { describe, expect, it } from "vite-plus/test";

import {
  LEGACY_PAIRING_FILE_ERROR,
  legacyPairingCommand,
  withLegacyPairingError,
} from "./legacyPairing";

const denied = { canReadFiles: false, isPending: false, error: null };

describe("withLegacyPairingError", () => {
  it("explains a read denial on a pairing from before the permission split", () => {
    const session = {
      authenticated: true,
      permissions: ["orchestration:read", "orchestration:operate"] as const,
    };
    expect(withLegacyPairingError(denied, session).error).toBe(LEGACY_PAIRING_FILE_ERROR);
  });

  it("leaves current pairings, granted reads and other errors alone", () => {
    const current = {
      authenticated: true,
      permissions: ["orchestration:read", "terminal:read"] as const,
    };
    expect(withLegacyPairingError(denied, current).error).toBeNull();
    const legacy = { authenticated: true, permissions: ["orchestration:read"] as const };
    expect(withLegacyPairingError({ ...denied, canReadFiles: true }, legacy).error).toBeNull();
    expect(withLegacyPairingError({ ...denied, error: "offline" }, legacy).error).toBe("offline");
    expect(withLegacyPairingError(denied, null).error).toBeNull();
  });
});

describe("legacyPairingCommand", () => {
  it("runs the service's own CLI", () => {
    expect(legacyPairingCommand("0.0.46-fork.fork.6fe42df")).toBe(
      'T3CODE_HOME=~/.t3 ~/.t3/runtime/versions/0.0.46-fork.fork.6fe42df/t3 pair --label "Desktop app"',
    );
  });
});
