import { SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Switch } from "../ui/switch";
import { useVoiceInputStore } from "./voiceInputStore";

/** Fork: the dictation setting. Stored in this browser. */
export function VoiceInputSettingRow() {
  const enabled = useVoiceInputStore((state) => state.enabled);
  const setEnabled = useVoiceInputStore((state) => state.setEnabled);
  return (
    <SettingsRow
      {...searchableSetting("voice-input")}
      description="Adds a microphone button to the composer. Speech is transcribed on the machine running T3 Code with Whisper, so no audio leaves it. The first dictation downloads the speech model (about 550 MB)."
      control={<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Voice input" />}
    />
  );
}
