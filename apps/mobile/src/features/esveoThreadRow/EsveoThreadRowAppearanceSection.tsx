/**
 * Fork: Settings → Appearance toggle for the esveo Android thread row
 * (EsveoThreadRowContent.tsx). Hidden elsewhere, where that row is not used.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Platform } from "react-native";

import { updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { esveoThreadRowShowsProjectAtom } from "./esveoThreadRowPreferences";

export function EsveoThreadRowAppearanceSection() {
  const showsProject = useAtomValue(esveoThreadRowShowsProjectAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);

  if (Platform.OS !== "android") return null;

  return (
    <SettingsSection title="Thread list">
      <SettingsSwitchRow
        icon="folder"
        label="Show project"
        subtitle="Project icon and name in front of each thread's details"
        value={showsProject}
        onValueChange={(value) => savePreferences({ esveoThreadRowShowsProject: value })}
      />
    </SettingsSection>
  );
}
