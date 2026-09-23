import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";

/** Fork: the opt-in for the coordinator's Inbox of decisions, in Settings → General. */
export function ThreadDecisionsSettingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("thread-decisions")}
      serverScoped
      settingKeys={["enableThreadDecisions"]}
      description="Coordinators put the questions they need you to decide into an Inbox tab beside the chat, instead of numbering them in their messages. Needs thread orchestration. Running sessions pick up a change."
      resetAction={
        settings.enableThreadDecisions !== DEFAULT_UNIFIED_SETTINGS.enableThreadDecisions ? (
          <SettingResetButton
            label="coordinator decisions"
            onClick={() =>
              updateSettings({
                enableThreadDecisions: DEFAULT_UNIFIED_SETTINGS.enableThreadDecisions,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableThreadDecisions"]}
          checked={settings.enableThreadDecisions}
          disabled={!settings.enableThreadOrchestration}
          onCheckedChange={(checked) => updateSettings({ enableThreadDecisions: Boolean(checked) })}
          aria-label="Coordinator decisions"
        />
      }
    />
  );
}
