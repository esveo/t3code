import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, EsveoNotionError } from "@t3tools/contracts";
import { Schema } from "effect";
import { useState } from "react";

import { esveoSearchableSetting } from "~/components/esveoSettings/EsveoSettingBadge";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { esveoNotionEnvironment } from "./esveoNotionState";
import { useEsveoNotionStore } from "./esveoNotionStore";
import { useEsveoNotionStatus } from "./useEsveoNotionLink";

const INTEGRATIONS_URL = "https://www.notion.so/profile/integrations";

const isNotionError = Schema.is(EsveoNotionError);

// The server's messages are English; the row speaks German like the rest of the viewer.
const failureMessage = (failure: unknown) => {
  if (isNotionError(failure) && failure.reason === "unauthorized") {
    return "Notion hat das Secret abgelehnt. Prüfe, ob es vollständig kopiert ist.";
  }
  return failure instanceof Error ? failure.message : "Notion ist nicht erreichbar.";
};

/**
 * Fork: connects the environment's server to a Notion integration, so Notion
 * links open in a tab. The secret goes to the server's secret store; clients
 * only ever see its last four characters.
 */
export function EsveoNotionSettingsSection() {
  const environmentId = useNotionSettingsEnvironmentId();
  if (environmentId === null) return null;
  return (
    <SettingsSection title="Notion">
      <NotionConnectionRow environmentId={environmentId} />
    </SettingsSection>
  );
}

function NotionConnectionRow({ environmentId }: { environmentId: EnvironmentId }) {
  const status = useEsveoNotionStatus(environmentId);
  const connect = useAtomCommand(esveoNotionEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(esveoNotionEnvironment.disconnect, { reportFailure: false });
  const canWrite = useAtomValue(esveoNotionEnvironment.connect.permissionAtom(environmentId));
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => ReturnType<typeof connect>) => {
    setPending(true);
    setError(null);
    const result = await call();
    setPending(false);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag !== "Success") {
      setError(failureMessage(squashAtomCommandFailure(result)));
      return;
    }
    useEsveoNotionStore.getState().setStatus(environmentId, result.value);
    setSecret("");
    setReplacing(false);
  };
  const submit = () => {
    if (secret.trim() === "") return;
    void run(() => connect({ environmentId, input: { secret: secret.trim() } }));
  };

  const connected = status?.connected === true;
  const showForm = !connected || replacing;
  const secretLabel = `Secret ntn_••••${status?.secretLast4 ?? ""}`;
  // A rejected secret has no integration or workspace to name, and is not a working connection.
  const description = connected ? (
    status.secretInvalid ? (
      <>
        {secretLabel}
        <span className="block text-destructive-foreground">
          Notion lehnt dieses Secret ab. Ersetze es durch ein gültiges.
        </span>
      </>
    ) : (
      <>
        Verbunden · Integration „{status.botName ?? "?"}“ im Workspace „
        {status.workspaceName ?? "?"}“ · {secretLabel}
      </>
    )
  ) : (
    <>
      Notion-Links öffnen sich in einem Tab, sobald eine interne Integration verbunden ist. Lege sie
      unter{" "}
      <a href={INTEGRATIONS_URL} target="_blank" rel="noreferrer" className="underline">
        notion.so/profile/integrations
      </a>{" "}
      an, füge ihr Secret hier ein und gib ihr in Notion die Seiten frei (••• → Connections).
    </>
  );

  return (
    <SettingsRow
      {...esveoSearchableSetting("esveo-notion")}
      description={description}
      status={error && <span className="text-destructive-foreground">{error}</span>}
      control={
        showForm ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              type="password"
              size="sm"
              autoComplete="off"
              placeholder="ntn_…"
              aria-label="Notion-Integration-Secret"
              value={secret}
              disabled={!canWrite || pending}
              onChange={(event) => setSecret(event.target.value)}
              className="w-56"
            />
            <Button type="submit" size="sm" disabled={!canWrite || pending || secret.trim() === ""}>
              Verbinden
            </Button>
            {replacing && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)}>
                Abbrechen
              </Button>
            )}
          </form>
        ) : (
          <span className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite || pending}
              onClick={() => setReplacing(true)}
            >
              Secret ersetzen
            </Button>
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={!canWrite || pending}
              onClick={() => void run(() => disconnect({ environmentId, input: {} }))}
            >
              Trennen
            </Button>
          </span>
        )
      }
    />
  );
}

/** The scoped environment, else the primary one, else the first known. */
function useNotionSettingsEnvironmentId(): EnvironmentId | null {
  const scopedEnvironmentId = useOptionalSettingsScope()?.scope.environmentIds[0] ?? null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return scopedEnvironmentId ?? primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
}
