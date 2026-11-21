import { useGT } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { esveoSearchableSetting } from "~/components/esveoSettings/EsveoSettingBadge";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";

/** Fork: lets agents' thread tools reach other projects, in Settings → General. */
export function CrossProjectThreadsSettingRow() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("cross-project-threads")}
      serverScoped
      settingKeys={["enableCrossProjectThreads"]}
      description={gt(
        "Let agents read, message and start threads in other projects of this environment. Running sessions pick up a change.",
      )}
      resetAction={
        settings.enableCrossProjectThreads !==
        DEFAULT_UNIFIED_SETTINGS.enableCrossProjectThreads ? (
          <SettingResetButton
            ariaLabel={gt("Reset cross-project threads to default")}
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
          aria-label={gt("Cross-project threads")}
        />
      }
    />
  );
}
