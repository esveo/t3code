import { useGT } from "gt-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES,
  MIN_IDLE_AUTO_COMPACT_CONTEXT_TOKENS,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  esveoSearchableSetting,
  forkSearchableSetting,
} from "~/components/esveoSettings/EsveoSettingBadge";
import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
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

/** Fork: idle auto-compact for Claude threads, in Settings → Threads. */
export function IdleAutoCompactSettingRows() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const changed = KEYS.some((key) => settings[key] !== DEFAULT_UNIFIED_SETTINGS[key]);
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("idle-auto-compact")}
        serverScoped
        settingKeys={[...KEYS]}
        description={gt(
          "Send /compact to a large, idle Claude thread shortly before its 1-hour prompt cache expires, so the next message skips caching the whole conversation again. 5-minute caches are left alone.",
        )}
        resetAction={
          changed ? (
            <SettingResetButton
              ariaLabel={gt("Reset idle auto-compact to default")}
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
            aria-label={gt("Auto-compact idle Claude threads")}
          />
        }
      />
      {settings.enableIdleAutoCompact ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["idleAutoCompactAfterMinutes"]}
            title={forkSearchableSetting("idle-auto-compact-after").title}
            description={gt("Between {min} and {max}; it has to fall inside the cache's hour.", {
              min: MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES,
              max: MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES,
            })}
            control={
              <BoundedIntInput
                value={settings.idleAutoCompactAfterMinutes}
                min={MIN_IDLE_AUTO_COMPACT_AFTER_MINUTES}
                max={MAX_IDLE_AUTO_COMPACT_AFTER_MINUTES}
                onCommit={(minutes) => updateSettings({ idleAutoCompactAfterMinutes: minutes })}
                aria-label={gt("Minutes idle before auto-compact")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["idleAutoCompactMinContextTokens"]}
            title={forkSearchableSetting("idle-auto-compact-threshold").title}
            description={gt(
              "Smaller threads are cheap to cache again and keep their full history.",
            )}
            control={
              <BoundedIntInput
                value={settings.idleAutoCompactMinContextTokens}
                min={MIN_IDLE_AUTO_COMPACT_CONTEXT_TOKENS}
                step={10_000}
                onCommit={(tokens) => updateSettings({ idleAutoCompactMinContextTokens: tokens })}
                aria-label={gt("Minimum context tokens for auto-compact")}
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
  // A draft only while editing, so the field can be emptied mid-edit; only valid
  // input commits, and blur drops the draft for the persisted value.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      size="sm"
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      className="w-full sm:w-28"
      value={draft ?? String(props.value)}
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
      onBlur={() => setDraft(null)}
      aria-label={props["aria-label"]}
    />
  );
}
