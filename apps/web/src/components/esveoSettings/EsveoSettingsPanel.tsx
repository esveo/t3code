import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { AgentStageSettingRow } from "../agentStage/AgentStageSetting";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { ThreadDecisionsSettingRow } from "../threadInbox/ThreadDecisionsSettingRow";
import { CrossProjectThreadsSettingRow } from "../threadOrchestration/CrossProjectThreadsSettingRow";
import { SidebarChildThreadsSettingRow } from "../threadOrchestration/SidebarChildThreadsSetting";
import { Switch } from "../ui/switch";
import { VoiceInputSettingRow } from "../voiceInput/VoiceInputSettingRow";

/** Fork: every setting esveo's fork adds, on the Settings → esveo page. */
export function EsveoSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection id="esveo-sidebar" title="Sidebar">
        <SettingsRow
          {...searchableSetting("two-line-thread-cards")}
          description="Trail the provider icon behind the thread title instead of giving it a line of its own. The line it saves also carried the branch, pull request badge and diff counts."
          resetAction={
            settings.twoLineThreadCards !== DEFAULT_UNIFIED_SETTINGS.twoLineThreadCards ? (
              <SettingResetButton
                label="two-line thread cards"
                onClick={() =>
                  updateSettings({
                    twoLineThreadCards: DEFAULT_UNIFIED_SETTINGS.twoLineThreadCards,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.twoLineThreadCards}
              onCheckedChange={(checked) =>
                updateSettings({ twoLineThreadCards: Boolean(checked) })
              }
              aria-label="Two-line thread cards"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("group-sidebar-threads-by-project")}
          description="Keep each project's threads together in the sidebar, under a header that folds the project away. Ordering stays by recency: the project with the newest thread leads."
          resetAction={
            settings.groupSidebarThreadsByProject !==
            DEFAULT_UNIFIED_SETTINGS.groupSidebarThreadsByProject ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    groupSidebarThreadsByProject:
                      DEFAULT_UNIFIED_SETTINGS.groupSidebarThreadsByProject,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.groupSidebarThreadsByProject}
              onCheckedChange={(checked) =>
                updateSettings({ groupSidebarThreadsByProject: Boolean(checked) })
              }
              aria-label="Group sidebar threads by project"
            />
          }
        />

        <SidebarChildThreadsSettingRow />
      </SettingsSection>

      <SettingsSection id="esveo-chat" title="Chat">
        <SettingsRow
          {...searchableSetting("context-window-control")}
          description="Show how full the thread's context window is next to the composer controls."
          resetAction={
            settings.contextWindowControlEnabled !==
            DEFAULT_UNIFIED_SETTINGS.contextWindowControlEnabled ? (
              <SettingResetButton
                label="context window usage"
                onClick={() =>
                  updateSettings({
                    contextWindowControlEnabled:
                      DEFAULT_UNIFIED_SETTINGS.contextWindowControlEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.contextWindowControlEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ contextWindowControlEnabled: Boolean(checked) })
              }
              aria-label="Context window usage"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("prompt-cache-timer")}
          description="Show how many minutes are left before the prompt cache expires. Claude only."
          resetAction={
            settings.promptCacheTimerEnabled !==
            DEFAULT_UNIFIED_SETTINGS.promptCacheTimerEnabled ? (
              <SettingResetButton
                label="prompt cache timer"
                onClick={() =>
                  updateSettings({
                    promptCacheTimerEnabled: DEFAULT_UNIFIED_SETTINGS.promptCacheTimerEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.promptCacheTimerEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ promptCacheTimerEnabled: Boolean(checked) })
              }
              aria-label="Prompt cache timer"
            />
          }
        />

        <VoiceInputSettingRow />
        <AgentStageSettingRow />
      </SettingsSection>

      <SettingsSection id="esveo-orchestration" title="Orchestration">
        <ThreadDecisionsSettingRow />
        <CrossProjectThreadsSettingRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
