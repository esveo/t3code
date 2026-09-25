import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { useEnvironmentQuery } from "~/state/query";
import { SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { describeVoiceInputPreparation } from "./voiceInput.logic";
import { startVoiceInputModelDownload } from "./voiceInputDownloadToast";
import { voiceInputEnvironment } from "./voiceInputState";
import { useVoiceInputStore } from "./voiceInputStore";

/**
 * Fork: the dictation setting. Stored in this browser. Turning it on downloads
 * the speech model right away, so the first dictation does not wait for it.
 */
export function VoiceInputSettingRow() {
  const enabled = useVoiceInputStore((state) => state.enabled);
  const setEnabled = useVoiceInputStore((state) => state.setEnabled);
  const environmentId = useVoiceInputEnvironmentId();
  const registry = useContext(RegistryContext);
  const onCheckedChange = (checked: boolean) => {
    setEnabled(checked);
    if (checked && environmentId) startVoiceInputModelDownload(registry, environmentId);
  };
  return (
    <SettingsRow
      {...searchableSetting("voice-input")}
      description="Adds a microphone button to the composer. Speech is transcribed on the machine running T3 Code with Whisper, so no audio leaves it. Turning this on downloads the speech model (about 550 MB)."
      status={
        enabled && environmentId ? <VoiceInputModelStatus environmentId={environmentId} /> : null
      }
      control={
        <Switch checked={enabled} onCheckedChange={onCheckedChange} aria-label="Voice input" />
      }
    />
  );
}

function VoiceInputModelStatus(props: { readonly environmentId: EnvironmentId }) {
  const preparation = useEnvironmentQuery(
    voiceInputEnvironment.prepare({ environmentId: props.environmentId, input: {} }),
  );
  if (preparation.error) {
    return (
      <span className="flex items-center gap-2 text-destructive-foreground">
        Couldn't download the speech model: {preparation.error}
        <Button type="button" variant="outline" size="xs" onClick={preparation.refresh}>
          Retry
        </Button>
      </span>
    );
  }
  if (preparation.data?.phase === "ready") return <span>Speech model ready.</span>;
  return (
    <span className="flex items-center gap-1.5">
      <Spinner size="xs" />
      {describeVoiceInputPreparation(preparation.data) ?? "Checking the speech model…"}
    </span>
  );
}

/**
 * The environment whose model the setting downloads: the one picked in the
 * settings scope, else the primary one, else the first known. The desktop app
 * can run without a primary one.
 */
function useVoiceInputEnvironmentId(): EnvironmentId | null {
  const scopedEnvironmentId = useOptionalSettingsScope()?.scope.environmentIds[0] ?? null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return scopedEnvironmentId ?? primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
}
