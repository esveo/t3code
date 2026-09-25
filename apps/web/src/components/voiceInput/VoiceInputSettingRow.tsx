import type { EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { describeVoiceInputPreparation } from "./voiceInput.logic";
import { voiceInputEnvironment } from "./voiceInputState";
import { useVoiceInputStore } from "./voiceInputStore";

/**
 * Fork: the dictation setting. Stored in this browser. Turning it on downloads
 * the speech model right away, so the first dictation does not wait for it.
 */
export function VoiceInputSettingRow() {
  const enabled = useVoiceInputStore((state) => state.enabled);
  const setEnabled = useVoiceInputStore((state) => state.setEnabled);
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsRow
      {...searchableSetting("voice-input")}
      description="Adds a microphone button to the composer. Speech is transcribed on the machine running T3 Code with Whisper, so no audio leaves it. Turning this on downloads the speech model (about 550 MB)."
      status={
        enabled && environmentId ? <VoiceInputModelStatus environmentId={environmentId} /> : null
      }
      control={<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Voice input" />}
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
