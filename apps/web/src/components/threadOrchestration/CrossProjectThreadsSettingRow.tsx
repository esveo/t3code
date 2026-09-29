import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";

/** Fork: lets agents' thread tools reach other projects, in Settings → General. */
export function CrossProjectThreadsSettingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("cross-project-threads")}
      serverScoped
      settingKeys={["enableCrossProjectThreads"]}
      description="Let agents read, message and start threads in other projects of this environment. Running sessions pick up a change."
      resetAction={
        settings.enableCrossProjectThreads !==
        DEFAULT_UNIFIED_SETTINGS.enableCrossProjectThreads ? (
          <SettingResetButton
            label="cross-project threads"
            onClick={() =>
              updateSettings({
                enableCrossProjectThreads: DEFAULT_UNIFIED_SETTINGS.enableCrossProjectThreads,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableCrossProjectThreads"]}
          checked={settings.enableCrossProjectThreads}
          onCheckedChange={(checked) =>
            updateSettings({ enableCrossProjectThreads: Boolean(checked) })
          }
          aria-label="Cross-project threads"
        />
      }
    />
  );
}
