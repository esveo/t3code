import { SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Switch } from "../ui/switch";
import { useAgentStageStore } from "./agentStageStore";

/** The setting that puts the stage toggle into the chat header. Stored in this browser. */
export function AgentStageSettingRow() {
  const enabled = useAgentStageStore((state) => state.enabled);
  const setEnabled = useAgentStageStore((state) => state.setEnabled);
  return (
    <SettingsRow
      {...searchableSetting("agent-stage")}
      description="Adds a button to the chat header that shows the agents as figures moving between the kinds of work they do: thinking, reading, editing, running commands and more."
      control={<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Agent stage" />}
    />
  );
}
