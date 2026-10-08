import { useAtomValue } from "@effect/atom-react";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { toastManager } from "../ui/toast";
import { legacyPairingCommand } from "./legacyPairing";

// One toast per environment and launch, also across Strict Mode effect replay.
const shown = new Set<EnvironmentId>();

function EnvironmentLegacyPairingNotice({
  environmentId,
  label,
  serverVersion,
}: {
  environmentId: EnvironmentId;
  label: string;
  serverVersion: string | undefined;
}) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const navigate = useNavigate();
  useEffect(() => {
    if (
      session._tag !== "Success" ||
      session.waiting ||
      !sessionHasLegacyPermissions(session.value) ||
      shown.has(environmentId)
    ) {
      return;
    }
    shown.add(environmentId);
    const command = legacyPairingCommand(serverVersion);
    const id = toastManager.add({
      title: `Pair ${label} again`,
      description: `This connection was paired before esveo code split up its permissions, so files, diffs and search do not work. Run the copied command in Terminal, then under Settings → Connections remove ${label} and add the printed URL as Host.`,
      timeout: 0,
      actionProps: {
        children: "Copy command",
        onClick: () => void navigator.clipboard.writeText(command),
      },
      data: {
        actionLayout: "stacked-end",
        secondaryActionProps: {
          children: "Open Connections",
          onClick: () => {
            toastManager.close(id);
            void navigate({ to: "/settings/connections" });
          },
        },
        secondaryActionVariant: "ghost",
      },
    });
  }, [environmentId, label, navigate, serverVersion, session]);
  return null;
}

/**
 * Replaces upstream's PermissionUpdateNotice: that one is gone for good after one
 * dismissal and only says to pair again. This one returns on every launch until
 * the connection is paired again, and carries the command that does it.
 */
export function LegacyPairingNotice() {
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentLegacyPairingNotice
      key={environmentId}
      environmentId={environmentId}
      label={label}
      serverVersion={serverConfigs.get(environmentId)?.environment.serverVersion}
    />
  ));
}
