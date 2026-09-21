// Private fork: the t3 service updates apart from the app, because restarting
// it ends every running agent session. See apps/desktop/src/updates/ForkAppUpdates.ts.
import type { DesktopForkServiceState, DesktopUpdateState } from "@t3tools/contracts";
import { AppWindowIcon, CheckIcon, ServerCogIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Fork builds report the service beside the app; the regular updater never does. */
export function isForkUpdateState(state: DesktopUpdateState | null): boolean {
  return state?.forkService !== undefined;
}

export function getForkAppUpdateTooltip(): string {
  return "Restart app to update";
}

/** The app's update glyph, distinct from the service's. */
export function ForkAppUpdateIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <AppWindowIcon className="size-4" />
      <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
        <CheckIcon className="size-2" strokeWidth={3} />
      </span>
    </span>
  );
}

export function getForkServiceTooltip(service: DesktopForkServiceState): string {
  if (service.restarting) return "Restarting service…";
  if (service.error) return "Service restart failed. Click to retry.";
  if (service.pendingVersion) return "Restart service to update (ends running sessions)";
  return "Service update needs manual setup";
}

export function ForkServiceUpdateButton() {
  return isElectron ? <ForkServiceUpdateControl /> : null;
}

/**
 * Asks before restarting, since the restart ends every agent session. Resolves
 * once the service is back up or the user declined.
 */
export async function restartForkServiceWithConfirmation(pendingVersion: string): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge?.restartForkService) return;
  const confirmed = await ensureLocalApi().dialogs.confirm(
    [
      `Restart the T3 service on ${pendingVersion}?`,
      "This ends all running agent sessions. Agents in the middle of a turn stop and do not resume on their own.",
    ].join("\n\n"),
    { variant: "destructive" },
  );
  if (!confirmed) return;
  const failure = await bridge.restartForkService().then(
    (next) => next.forkService?.error ?? null,
    (error: unknown) => (error instanceof Error ? error.message : "An unexpected error occurred."),
  );
  if (failure) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not restart the service",
        description: failure,
      }),
    );
  }
}

function useForkServiceRestart() {
  const state = useDesktopUpdateState();
  const [isPending, setIsPending] = useState(false);
  const service = state?.forkService;
  const pendingVersion = service?.pendingVersion ?? null;
  const canRestart = pendingVersion !== null && !service?.restarting && !isPending;
  const restart = useCallback(() => {
    if (!canRestart || pendingVersion === null) return;
    setIsPending(true);
    void restartForkServiceWithConfirmation(pendingVersion).finally(() => setIsPending(false));
  }, [canRestart, pendingVersion]);
  return { service, canRestart, restart };
}

function ForkServiceUpdateControl() {
  const { service, canRestart, restart } = useForkServiceRestart();
  if (!service || (!service.pendingVersion && !service.blockedReason)) return null;
  const warn = Boolean(service.error) || !service.pendingVersion;
  const tooltip = getForkServiceTooltip(service);

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={!canRestart || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2",
                canRestart ? "cursor-pointer hover:bg-sidebar-row-hover" : "cursor-not-allowed",
                service.restarting && "opacity-60",
              )}
              onClick={restart}
            >
              {warn ? (
                <TriangleAlertIcon className="size-4 text-warning" />
              ) : (
                <ServerCogIcon className="size-4" />
              )}
            </button>
          }
        />
        <TooltipPopup align="center" side="top" variant="glass">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/** The settings entry for the same restart, for fork builds only. */
export function ForkServiceSettingsRow() {
  const { service, canRestart, restart } = useForkServiceRestart();
  if (!service) return null;
  const running = `Running ${service.runningVersion ?? "an unknown version"}.`;
  const description = service.error
    ? `Restart failed: ${service.error}`
    : service.pendingVersion
      ? `${service.pendingVersion} is ready. Restarting ends running agent sessions.`
      : (service.blockedReason ?? running);
  return (
    <SettingsRow
      title="Background service"
      description={description}
      control={
        <Button size="sm" variant="outline" disabled={!canRestart} onClick={restart}>
          {service.restarting ? "Restarting…" : "Restart Service"}
        </Button>
      }
    />
  );
}
