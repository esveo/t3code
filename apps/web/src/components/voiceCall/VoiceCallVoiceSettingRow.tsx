import { DEFAULT_VOICE_CALL_VOICE, VOICE_CALL_VOICES } from "@t3tools/contracts";

import { esveoSearchableSetting } from "../esveoSettings/EsveoSettingBadge";
import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const voiceLabel = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);

/** Fork: the switch for the whole feature, including the agents' `voice_say`. */
export function VoiceCallEnabledSettingRow() {
  const enabled = useScopedSettings((settings) => settings.voiceCallEnabled);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("voice-call-enabled")}
      description="Talk to your agents by voice with GPT-Live on your Codex ChatGPT login. Turning this off ends a running call."
      resetAction={
        enabled ? (
          <SettingResetButton
            label="voice calls"
            onClick={() => updateSettings({ voiceCallEnabled: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ voiceCallEnabled: Boolean(checked) })}
          aria-label="Voice calls"
        />
      }
    />
  );
}

/** Fork: what a voice message does while the agent works, apart from the chat's follow-up behavior. */
export function VoiceCallFollowUpSettingRow() {
  const behavior = useScopedSettings((settings) => settings.voiceCallFollowUpBehavior);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("voice-call-follow-up")}
      description="Queue what you say in a voice call while the agent runs, or steer the current run. Saying otherwise overrides it for one message. A change applies from the next call."
      resetAction={
        behavior !== "steer" ? (
          <SettingResetButton
            label="voice call follow-up"
            onClick={() => updateSettings({ voiceCallFollowUpBehavior: "steer" })}
          />
        ) : null
      }
      control={
        <Select
          value={behavior}
          onValueChange={(value) => {
            if (value === "queue" || value === "steer") {
              updateSettings({ voiceCallFollowUpBehavior: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="Voice call follow-up">
            <SelectValue>{behavior === "queue" ? "Queue" : "Steer"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="queue">Queue</SelectItem>
            <SelectItem value="steer">Steer</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Fork: which voice speaks in voice calls. */
export function VoiceCallVoiceSettingRow() {
  const voice = useScopedSettings((settings) => settings.voiceCallVoice);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("voice-call-voice")}
      description="The voice that talks to you in a voice call. A change applies from the next call."
      resetAction={
        voice !== DEFAULT_VOICE_CALL_VOICE ? (
          <SettingResetButton
            label="voice call voice"
            onClick={() => updateSettings({ voiceCallVoice: DEFAULT_VOICE_CALL_VOICE })}
          />
        ) : null
      }
      control={
        <Select
          value={voice}
          onValueChange={(value) => {
            const choice = VOICE_CALL_VOICES.find((candidate) => candidate === value);
            if (choice) updateSettings({ voiceCallVoice: choice });
          }}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Voice call voice">
            <SelectValue>{voiceLabel(voice)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {VOICE_CALL_VOICES.map((choice) => (
              <SelectItem key={choice} hideIndicator value={choice}>
                {voiceLabel(choice)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
