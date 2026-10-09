import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_UNIFIED_SETTINGS,
  type EditorId,
  type EnvironmentId,
  USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH,
  type UserInsightsAction,
  type UserInsightsSnapshot,
  type UserInsightsTrait,
} from "@t3tools/contracts";
import { FolderOpenIcon, PencilIcon, PinIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { esveoSearchableSetting } from "~/components/esveoSettings/EsveoSettingBadge";
import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  CONFIDENCE_LABELS,
  capsText,
  confidenceLevel,
  formatUsageTotals,
  statusText,
  traitLabel,
} from "./userInsightsFormat";
import { UserInsightsImport } from "./UserInsightsImport";
import { userInsightsEnvironment } from "./userInsightsState";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/** The one environment the settings page shows, or null when several are selected. */
function useSingleEnvironmentId(): EnvironmentId | null {
  const context = useOptionalSettingsScope();
  const primary = usePrimaryEnvironmentId();
  if (context === null) return primary;
  return context.scope.environmentIds.length === 1
    ? (context.environment?.environmentId ?? null)
    : null;
}

/**
 * Fork: user insights in Settings → General. The two toggles, then what the
 * environment learned, what it cost, and the ways to undo or remove it.
 */
export function UserInsightsSettingRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const on = settings.enableUserInsights;
  const environmentId = useSingleEnvironmentId();
  return (
    <>
      <SettingsRow
        {...esveoSearchableSetting("user-insights")}
        serverScoped
        settingKeys={["enableUserInsights"]}
        description="Learn how you write and work from the messages you type, to suggest your next message. Everything stays in a folder on this server. Learning runs in the background on Claude Haiku and counts against your Claude usage."
        resetAction={
          on !== DEFAULT_UNIFIED_SETTINGS.enableUserInsights ? (
            <SettingResetButton
              label="user insights"
              onClick={() =>
                updateSettings({ enableUserInsights: DEFAULT_UNIFIED_SETTINGS.enableUserInsights })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["enableUserInsights"]}
            checked={on}
            onCheckedChange={(checked) => updateSettings({ enableUserInsights: Boolean(checked) })}
            aria-label="User insights"
          />
        }
      />
      {on ? (
        <SettingsRow
          {...esveoSearchableSetting("user-insights-suggestions")}
          serverScoped
          settingKeys={["enableUserInsightsSuggestions"]}
          description="Once enough is learned, offer up to three next messages above the composer after a turn finishes. Picking one fills the composer; nothing is sent on its own."
          resetAction={
            settings.enableUserInsightsSuggestions !==
            DEFAULT_UNIFIED_SETTINGS.enableUserInsightsSuggestions ? (
              <SettingResetButton
                label="prompt suggestions"
                onClick={() =>
                  updateSettings({
                    enableUserInsightsSuggestions:
                      DEFAULT_UNIFIED_SETTINGS.enableUserInsightsSuggestions,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["enableUserInsightsSuggestions"]}
              checked={settings.enableUserInsightsSuggestions}
              onCheckedChange={(checked) =>
                updateSettings({ enableUserInsightsSuggestions: Boolean(checked) })
              }
              aria-label="Prompt suggestions"
            />
          }
        />
      ) : null}
      {environmentId === null ? (
        on ? (
          <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
            Select one environment to see what it learned.
          </p>
        ) : null
      ) : (
        <UserInsightsDetails
          environmentId={environmentId}
          on={on}
          turnOff={() => updateSettings({ enableUserInsights: false })}
        />
      )}
    </>
  );
}

type Confirm = "reset" | "delete" | null;

function UserInsightsDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly on: boolean;
  readonly turnOff: () => void;
}) {
  const { environmentId, on, turnOff } = props;
  const query = useEnvironmentQuery(userInsightsEnvironment.read({ environmentId, input: {} }));
  const { refresh } = query;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const act = useAtomCommand(userInsightsEnvironment.act, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [editing, setEditing] = useState<UserInsightsTrait["id"] | null>(null);
  const [draft, setDraft] = useState("");

  // The snapshot changes with the toggle, so read it again when the toggle flips.
  const shownFor = useRef(on);
  useEffect(() => {
    if (shownFor.current === on) return;
    shownFor.current = on;
    refresh();
  }, [on, refresh]);

  const send = useCallback(
    async (action: UserInsightsAction, failureTitle: string) => {
      setBusy(true);
      const result = await act({ environmentId, input: action });
      setBusy(false);
      reportFailure(failureTitle, result);
      refresh();
      return result._tag === "Success";
    },
    [act, environmentId, refresh],
  );

  const snapshot = query.data;
  if (snapshot === null) {
    if (!on) return null;
    return (
      <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
        {query.error ?? "Loading what this environment learned…"}
      </p>
    );
  }
  if (!on && !snapshot.hasStoredData) return null;

  const saveEdit = async () => {
    if (editing === null) return;
    const ok = await send({ type: "trait.edit", id: editing, value: draft }, "Could not save");
    if (ok) setEditing(null);
  };

  return (
    <div className="space-y-4 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
      {on ? (
        <>
          <p className="text-foreground">{statusText(snapshot.status)}</p>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-foreground">Learned profile</h4>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canOperate || busy || snapshot.traits.length === 0}
                onClick={() => void send({ type: "profile.undo" }, "Could not undo")}
              >
                <Undo2Icon />
                Undo last update
              </Button>
            </div>
            {snapshot.traits.length === 0 ? (
              <p>Nothing learned yet. The first update comes after a few messages.</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                {snapshot.traits.map((trait) => (
                  <li key={trait.id} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5 text-foreground">
                        <span className="font-medium">{traitLabel(trait.id)}</span>
                        <Badge variant="outline" size="sm">
                          {CONFIDENCE_LABELS[confidenceLevel(trait.confidence)]}
                        </Badge>
                        {trait.pinned ? (
                          <Tooltip>
                            <TooltipTrigger render={<span aria-label="Set by you" />}>
                              <PinIcon className="size-3" />
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              Set by you. Learning can confirm or question it, not replace it.
                            </TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </div>
                      {editing === trait.id ? (
                        <form
                          className="flex items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveEdit();
                          }}
                        >
                          <Input
                            size="sm"
                            value={draft}
                            maxLength={USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH}
                            onChange={(event) => setDraft(event.target.value)}
                            aria-label={`${traitLabel(trait.id)} value`}
                            autoFocus
                          />
                          <Button
                            type="submit"
                            size="xs"
                            disabled={busy || draft.trim().length === 0}
                          >
                            Save
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <p className="break-words">{trait.value}</p>
                      )}
                    </div>
                    {editing === trait.id ? null : (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          disabled={!canOperate || busy}
                          aria-label={`Edit ${traitLabel(trait.id)}`}
                          onClick={() => {
                            setDraft(trait.value);
                            setEditing(trait.id);
                          }}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost-destructive"
                          disabled={!canOperate || busy}
                          aria-label={`Delete ${traitLabel(trait.id)}`}
                          onClick={() =>
                            void send({ type: "trait.delete", id: trait.id }, "Could not delete")
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <UsageSection snapshot={snapshot} />
          <UserInsightsImport
            environmentId={environmentId}
            snapshot={snapshot}
            canOperate={canOperate}
            refresh={refresh}
          />
        </>
      ) : (
        <p>User insights are off. What was learned before is still stored on this server.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <OpenFolderButton environmentId={environmentId} path={snapshot.folderPath} />
        {on ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() => setConfirm("reset")}
          >
            Reset learned data
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={!canOperate || busy}
          onClick={() => setConfirm("delete")}
        >
          Delete everything
        </Button>
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "reset" ? "Reset learned data?" : "Delete everything?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reset"
                ? "Forgets the profile, the collected messages, the suggestion history and any import of past messages. Learning starts over from your next message. The usage history stays."
                : "Removes the whole folder, usage history included, and turns user insights off."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={confirm === "reset" ? "default" : "destructive"}
              disabled={busy}
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === "reset") {
                  void send({ type: "data.reset" }, "Could not reset");
                } else if (action === "delete") {
                  // Off first, so no message lands in the folder while it goes.
                  if (on) turnOff();
                  void send({ type: "data.deleteAll" }, "Could not delete");
                }
              }}
            >
              {confirm === "reset" ? "Reset" : "Delete everything"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function UsageSection(props: { readonly snapshot: UserInsightsSnapshot }) {
  const { usage } = props.snapshot;
  const rows = [
    ["Today", usage.today],
    ["Last 7 days", usage.last7Days],
    ["Last 90 days", usage.total],
  ] as const;
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">Usage</h4>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {rows.map(([label, totals]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="text-foreground tabular-nums">{formatUsageTotals(totals)}</dd>
          </div>
        ))}
      </dl>
      <p>
        Costs are what the same calls would cost on the API; they run on your Claude subscription.{" "}
        {capsText(usage)}
        {usage.lastDistillAt === null
          ? null
          : ` Last learned ${new Date(usage.lastDistillAt).toLocaleString()}.`}
      </p>
    </section>
  );
}

const NO_EDITORS: ReadonlyArray<EditorId> = [];

function OpenFolderButton(props: { readonly environmentId: EnvironmentId; readonly path: string }) {
  const environment = useOptionalSettingsScope()?.environment;
  const openInEditor = useOpenInPreferredEditor(
    props.environmentId,
    environment?.environmentId === props.environmentId
      ? (environment.serverConfig?.availableEditors ?? NO_EDITORS)
      : NO_EDITORS,
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!canOperate}
      onClick={() => {
        void openInEditor(props.path).then((result) =>
          reportFailure("Could not open the folder", result),
        );
      }}
    >
      <FolderOpenIcon />
      Open folder
    </Button>
  );
}
