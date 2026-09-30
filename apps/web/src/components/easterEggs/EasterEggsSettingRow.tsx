import { esveoSearchableSetting } from "../esveoSettings/EsveoSettingBadge";
import { SettingsRow } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { useEasterEggStore } from "./easterEggStore";

/** Fork: the opt-in for easter eggs, stored in this browser. */
export function EasterEggsSettingRow() {
  const enabled = useEasterEggStore((state) => state.enabled);
  const setEnabled = useEasterEggStore((state) => state.setEnabled);
  return (
    <SettingsRow
      {...esveoSearchableSetting("easter-eggs")}
      description="Some messages set off a little surprise when you send them. They still go to the agent as usual."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          aria-label="Easter eggs"
        />
      }
    />
  );
}
