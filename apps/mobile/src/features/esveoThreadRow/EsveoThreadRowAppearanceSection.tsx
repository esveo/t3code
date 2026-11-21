/**
 * Fork: Settings → Appearance toggle for the esveo Android thread row
 * (EsveoThreadRowContent.tsx). Hidden elsewhere, where that row is not used.
 */
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react-native";
import { Platform } from "react-native";

import { saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { esveoThreadRowShowsProjectAtom } from "./esveoThreadRowPreferences";

export function EsveoThreadRowAppearanceSection() {
  const gt = useGT();
  const showsProject = useAtomValue(esveoThreadRowShowsProjectAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);

  if (Platform.OS !== "android") return null;

  return (
    <SettingsSection title={gt("Thread list")}>
      <SettingsSwitchRow
        icon="folder"
        label={gt("Show project")}
        subtitle={gt("Project icon and name in front of each thread's details")}
        value={showsProject}
        onValueChange={(value) => void savePreferences({ esveoThreadRowShowsProject: value })}
      />
    </SettingsSection>
  );
}
