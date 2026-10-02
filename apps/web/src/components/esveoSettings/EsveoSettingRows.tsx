import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Switch } from "../ui/switch";
import { esveoSearchableSetting } from "./EsveoSettingBadge";

/** Fork: how sidebar thread cards look and group, in Settings → Appearance. */
export function EsveoSidebarCardSettingRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("two-line-thread-cards")}
        description="Trail the provider icon behind the thread title instead of giving it a line of its own. The line it saves also carried the branch, pull request badge and diff counts."
        resetAction={
          settings.twoLineThreadCards !== DEFAULT_UNIFIED_SETTINGS.twoLineThreadCards ? (
            <SettingResetButton
              label="two-line thread cards"
              onClick={() =>
                updateSettings({ twoLineThreadCards: DEFAULT_UNIFIED_SETTINGS.twoLineThreadCards })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.twoLineThreadCards}
            onCheckedChange={(checked) => updateSettings({ twoLineThreadCards: Boolean(checked) })}
            aria-label="Two-line thread cards"
          />
        }
      />
      <SettingsRow
        {...esveoSearchableSetting("group-sidebar-threads-by-project")}
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
    </>
  );
}

/** Fork: the context window and prompt cache readouts beside the composer, in Settings → General. */
export function EsveoComposerReadoutSettingRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("context-window-control")}
        description="Show how full the thread's context window is next to the composer controls."
        resetAction={
          settings.contextWindowControlEnabled !==
          DEFAULT_UNIFIED_SETTINGS.contextWindowControlEnabled ? (
            <SettingResetButton
              label="context window usage"
              onClick={() =>
                updateSettings({
                  contextWindowControlEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowControlEnabled,
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
        {...esveoSearchableSetting("prompt-cache-timer")}
        description="Show how many minutes are left before the prompt cache expires. Claude only."
        resetAction={
          settings.promptCacheTimerEnabled !== DEFAULT_UNIFIED_SETTINGS.promptCacheTimerEnabled ? (
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
    </>
  );
}

/** Fork: whether a thread's details card starts open, in Settings → Appearance. */
export function EsveoThreadDetailsSettingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("thread-details-open-by-default")}
      description="Open the thread details card with workspace and version control in every thread. Off, it stays closed until you open it, and each thread remembers your choice."
      resetAction={
        settings.threadDetailsOpenByDefault !==
        DEFAULT_UNIFIED_SETTINGS.threadDetailsOpenByDefault ? (
          <SettingResetButton
            label="thread details"
            onClick={() =>
              updateSettings({
                threadDetailsOpenByDefault: DEFAULT_UNIFIED_SETTINGS.threadDetailsOpenByDefault,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.threadDetailsOpenByDefault}
          onCheckedChange={(checked) =>
            updateSettings({ threadDetailsOpenByDefault: Boolean(checked) })
          }
          aria-label="Open thread details by default"
        />
      }
    />
  );
}
