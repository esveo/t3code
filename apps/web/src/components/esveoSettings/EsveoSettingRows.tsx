import { useGT } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Switch } from "../ui/switch";
import { esveoSearchableSetting } from "./EsveoSettingBadge";

/** Fork: how sidebar thread cards look and group, in Settings → Appearance. */
export function EsveoSidebarCardSettingRows() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("two-line-thread-cards")}
        description={gt(
          "Trail the provider icon behind the thread title instead of giving it a line of its own. The line it saves also carried the branch, pull request badge and diff counts.",
        )}
        resetAction={
          settings.twoLineThreadCards !== DEFAULT_UNIFIED_SETTINGS.twoLineThreadCards ? (
            <SettingResetButton
              ariaLabel={gt("Reset two-line thread cards to default")}
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
            aria-label={gt("Two-line thread cards")}
          />
        }
      />
      <SettingsRow
        {...esveoSearchableSetting("group-sidebar-threads-by-project")}
        description={gt(
          "Keep each project's threads together in the sidebar, under a header that folds the project away. Ordering stays by recency: the project with the newest thread leads.",
        )}
        resetAction={
          settings.groupSidebarThreadsByProject !==
          DEFAULT_UNIFIED_SETTINGS.groupSidebarThreadsByProject ? (
            <SettingResetButton
              ariaLabel={gt("Reset project grouping to default")}
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
            aria-label={gt("Group sidebar threads by project")}
          />
        }
      />
    </>
  );
}

/** Fork: the context window and prompt cache readouts beside the composer, in Settings → General. */
export function EsveoComposerReadoutSettingRows() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("context-window-control")}
        description={gt(
          "Show how full the thread's context window is next to the composer controls.",
        )}
        resetAction={
          settings.contextWindowControlEnabled !==
          DEFAULT_UNIFIED_SETTINGS.contextWindowControlEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset context window usage to default")}
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
            aria-label={gt("Context window usage")}
          />
        }
      />
      <SettingsRow
        {...esveoSearchableSetting("prompt-cache-timer")}
        description={gt(
          "Show how many minutes are left before the prompt cache expires. Claude only.",
        )}
        resetAction={
          settings.promptCacheTimerEnabled !== DEFAULT_UNIFIED_SETTINGS.promptCacheTimerEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset prompt cache timer to default")}
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
            aria-label={gt("Prompt cache timer")}
          />
        }
      />
    </>
  );
}

/** Fork: whether a thread's details card starts open, in Settings → Appearance. */
export function EsveoThreadDetailsSettingRow() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("thread-details-open-by-default")}
      description={gt(
        "Open the thread details card with workspace and version control in every thread. Off, it stays closed until you open it, and each thread remembers your choice.",
      )}
      resetAction={
        settings.threadDetailsOpenByDefault !==
        DEFAULT_UNIFIED_SETTINGS.threadDetailsOpenByDefault ? (
          <SettingResetButton
            ariaLabel={gt("Reset thread details to default")}
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
          aria-label={gt("Open thread details by default")}
        />
      }
    />
  );
}
