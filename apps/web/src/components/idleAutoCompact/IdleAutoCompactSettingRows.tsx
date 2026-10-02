import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  MIN_IDLE_AUTO_COMPACT_CONTEXT_TOKENS,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { esveoSearchableSetting } from "~/components/esveoSettings/EsveoSettingBadge";
import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import { Input } from "~/components/ui/input";

const KEYS = [
  "enableIdleAutoCompact",
  "idleAutoCompactAfterMinutes",
  "idleAutoCompactMinContextTokens",
] as const;

/** Fork: idle auto-compact for Claude threads, in Settings → General. */
export function IdleAutoCompactSettingRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const changed = KEYS.some((key) => settings[key] !== DEFAULT_UNIFIED_SETTINGS[key]);
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("idle-auto-compact")}
        serverScoped
        settingKeys={[...KEYS]}
        description="Send /compact to a large, idle Claude thread shortly before its 1-hour prompt cache expires, so the next message does not pay to cache the whole conversation again. Threads on a 5-minute cache are left alone."
        resetAction={
          changed ? (
            <SettingResetButton
              label="idle auto-compact"
              onClick={() =>
                updateSettings({
                  enableIdleAutoCompact: DEFAULT_UNIFIED_SETTINGS.enableIdleAutoCompact,
                  idleAutoCompactAfterMinutes: DEFAULT_UNIFIED_SETTINGS.idleAutoCompactAfterMinutes,
                  idleAutoCompactMinContextTokens:
                    DEFAULT_UNIFIED_SETTINGS.idleAutoCompactMinContextTokens,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["enableIdleAutoCompact"]}
            checked={settings.enableIdleAutoCompact}
            onCheckedChange={(checked) =>
              updateSettings({ enableIdleAutoCompact: Boolean(checked) })
            }
            aria-label="Auto-compact idle Claude threads"
          />
        }
      />
      {settings.enableIdleAutoCompact ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["idleAutoCompactAfterMinutes"]}
            title={searchableSetting("idle-auto-compact-after").title}
            description={`Between ${MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES} and ${MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES}; it has to fall inside the cache's hour.`}
            control={
              <BoundedIntInput
                value={settings.idleAutoCompactAfterMinutes}
                min={MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES}
                max={MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES}
                onCommit={(minutes) => updateSettings({ idleAutoCompactAfterMinutes: minutes })}
                aria-label="Minutes idle before auto-compact"
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["idleAutoCompactMinContextTokens"]}
            title={searchableSetting("idle-auto-compact-threshold").title}
            description="Smaller threads are cheap to cache again and keep their full history."
            control={
              <BoundedIntInput
                value={settings.idleAutoCompactMinContextTokens}
                min={MIN_IDLE_AUTO_COMPACT_CONTEXT_TOKENS}
                step={10_000}
                onCommit={(tokens) => updateSettings({ idleAutoCompactMinContextTokens: tokens })}
                aria-label="Minimum context tokens for auto-compact"
              />
            }
          />
        </>
      ) : null}
    </>
  );
}

function BoundedIntInput(props: {
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly step?: number;
  readonly onCommit: (value: number) => void;
  readonly "aria-label": string;
}) {
  // Local draft so the field can be emptied mid-edit; only valid input commits,
  // and blur snaps back to the persisted value.
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);
  return (
    <Input
      size="sm"
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      className="w-full sm:w-28"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= props.min &&
          (props.max === undefined || parsed <= props.max)
        ) {
          props.onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(props.value))}
      aria-label={props["aria-label"]}
    />
  );
}
