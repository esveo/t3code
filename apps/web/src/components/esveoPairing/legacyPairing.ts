import { sessionHasLegacyPermissions, type SessionGrantInput } from "@t3tools/contracts";

/**
 * Shown wherever files cannot be read because the connection was paired before
 * file permissions were split up (upstream #9788). The server never widens an
 * old grant, so pairing again is the only way back.
 */
export const LEGACY_PAIRING_FILE_ERROR =
  "This connection was paired before esveo code split up its permissions, so it cannot read files. Pair it again: the notice at the bottom right has the command.";

/** Mints a pairing URL against the fork's background service on this machine. */
export function legacyPairingCommand(serverVersion: string | null | undefined): string {
  const t3 = serverVersion ? `~/.t3/runtime/versions/${serverVersion}/t3` : "t3";
  return `T3CODE_HOME=~/.t3 ${t3} pair --label "Desktop app"`;
}

/** Explains a missing read grant on an old pairing instead of a generic denial. */
export function withLegacyPairingError<
  Access extends { readonly canReadFiles: boolean; readonly error: string | null },
>(access: Access, session: SessionGrantInput | null): Access {
  if (access.canReadFiles || access.error !== null) return access;
  if (session === null || !sessionHasLegacyPermissions(session)) return access;
  return { ...access, error: LEGACY_PAIRING_FILE_ERROR };
}
