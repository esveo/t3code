import { useGT } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { esveoSearchableSetting } from "~/components/esveoSettings/EsveoSettingBadge";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";

/** Fork: whether coordinating threads answer their child threads' questions, in Settings → General. */
export function ParentsAnswerChildQuestionsSettingRow() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...esveoSearchableSetting("parents-answer-child-questions")}
      serverScoped
      settingKeys={["parentsAnswerChildQuestions"]}
      description={gt(
        "Let a coordinating thread answer the questions and approvals of the threads it started. Off, only you answer them, and every thread above one that waits shows Waiting for you.",
      )}
      resetAction={
        settings.parentsAnswerChildQuestions !==
        DEFAULT_UNIFIED_SETTINGS.parentsAnswerChildQuestions ? (
          <SettingResetButton
            ariaLabel={gt("Reset parent threads answer child questions to default")}
            onClick={() =>
              updateSettings({
                parentsAnswerChildQuestions: DEFAULT_UNIFIED_SETTINGS.parentsAnswerChildQuestions,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["parentsAnswerChildQuestions"]}
          checked={settings.parentsAnswerChildQuestions}
          onCheckedChange={(checked) =>
            updateSettings({ parentsAnswerChildQuestions: Boolean(checked) })
          }
          aria-label={gt("Parent threads answer child questions")}
        />
      }
    />
  );
}
