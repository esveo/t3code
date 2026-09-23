import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";

/** Fork: the opt-in for thread orchestration, in Settings → General. */
export function ThreadOrchestrationSettingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("thread-orchestration")}
      serverScoped
      settingKeys={["enableThreadOrchestration"]}
      description="Let an agent start and coordinate threads of its own, each on its own branch, grouped under the thread that started them. New sessions pick up a change."
      resetAction={
        settings.enableThreadOrchestration !==
        DEFAULT_UNIFIED_SETTINGS.enableThreadOrchestration ? (
          <SettingResetButton
            label="thread orchestration"
            onClick={() =>
              updateSettings({
                enableThreadOrchestration: DEFAULT_UNIFIED_SETTINGS.enableThreadOrchestration,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableThreadOrchestration"]}
          checked={settings.enableThreadOrchestration}
          onCheckedChange={(checked) =>
            updateSettings({ enableThreadOrchestration: Boolean(checked) })
          }
          aria-label="Thread orchestration"
        />
      }
    />
  );
}
