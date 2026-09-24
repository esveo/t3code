// Fork: the sidebar's update button as a drop-up that lists every
// branch's waiting build, each with its own update and delete.
import type { DesktopForkBuild, DesktopUpdateState } from "@t3tools/contracts";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { DesktopUpdateStatusIcon } from "../sidebar/DesktopUpdateStatusIcon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { describeForkBuild, getForkUpdateTooltip, isForkUpdateState } from "./forkUpdate";

/** Renders the fork's menu when the desktop reports fork builds, else the given control. */
export function ForkUpdatePill({ fallback }: { readonly fallback: ReactNode }) {
  const state = useDesktopUpdateState();
  if (!isForkUpdateState(state)) return fallback;
  return <ForkUpdateMenu state={state} />;
}

function toastError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    }),
  );
}

function ForkUpdateMenu({
  state,
}: {
  readonly state: DesktopUpdateState & {
    forkService: NonNullable<DesktopUpdateState["forkService"]>;
  };
}) {
  const [open, setOpen] = useState(false);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const builds = state.forkBuilds ?? [];
  const service = state.forkService;
  const pendingRestart =
    builds.length === 0 && service.pendingVersion !== null && service.blockedReason === null
      ? service.pendingVersion
      : null;
  const hasOffer = builds.length > 0 || pendingRestart !== null;
  const tooltip = getForkUpdateTooltip(state);
  const busy = pendingSlug !== null;

  const act = useCallback(
    (kind: "install" | "delete", slug: string) => {
      const bridge = window.desktopBridge;
      if (!bridge?.forkBuildAction || busy) return;
      setPendingSlug(slug);
      setConfirmDeleteSlug(null);
      void bridge
        .forkBuildAction({ kind, slug })
        .then((result) => {
          if (result.completed) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: kind === "install" ? "Could not install build" : "Could not delete build",
              description: result.state.message ?? "The build is no longer there.",
            }),
          );
        })
        .catch((error) =>
          toastError(
            kind === "install" ? "Could not install build" : "Could not delete build",
            error,
          ),
        )
        .finally(() => setPendingSlug(null));
    },
    [busy],
  );

  // A pending service restart with no build installs through the plain path.
  const installPending = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || busy) return;
    setPendingSlug("service");
    void bridge
      .installUpdate()
      .catch((error) => toastError("Could not restart the service", error))
      .finally(() => setPendingSlug(null));
  }, [busy]);

  const check = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || isChecking) return;
    setIsChecking(true);
    void bridge
      .checkForUpdate()
      .catch((error) => toastError("Could not check for updates", error))
      .finally(() => setIsChecking(false));
  }, [isChecking]);

  const trigger = (
    <button
      type="button"
      aria-label={tooltip}
      className={cn(
        "inline-flex size-8 cursor-pointer items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
        hasOffer
          ? "bg-sidebar-control-surface text-sidebar-foreground hover:bg-sidebar-row-hover"
          : "text-[var(--sidebar-icon-color)] hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
      )}
    >
      <DesktopUpdateStatusIcon
        isCheckAnimating={isChecking}
        status={isChecking ? "checking" : hasOffer ? "downloaded" : "idle"}
      />
    </button>
  );

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmDeleteSlug(null);
        }}
      >
        <Tooltip disabled={open}>
          <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
          <TooltipPopup align="center" side="top">
            {tooltip}
          </TooltipPopup>
        </Tooltip>
        <PopoverPopup align="end" aria-label="Builds" side="top" width="md">
          <div className="text-xs">
            <div className="border-b border-border px-3 py-2">
              <div className="font-medium">Running</div>
              <div className="truncate text-muted-foreground">{state.currentVersion}</div>
              <div className="truncate text-muted-foreground">
                Service {service.runningVersion ?? "unknown"}
              </div>
            </div>
            {hasOffer ? (
              <ul className="max-h-72 overflow-y-auto py-1">
                {builds.map((build) => (
                  <ForkBuildRow
                    build={build}
                    busy={busy}
                    confirmDelete={confirmDeleteSlug === build.slug}
                    key={build.slug}
                    onDelete={() =>
                      confirmDeleteSlug === build.slug
                        ? act("delete", build.slug)
                        : setConfirmDeleteSlug(build.slug)
                    }
                    onInstall={() => act("install", build.slug)}
                    pending={pendingSlug === build.slug}
                  />
                ))}
                {pendingRestart !== null ? (
                  <li className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">Service restart pending</div>
                      <div className="truncate text-muted-foreground">{pendingRestart}</div>
                    </div>
                    <Button disabled={busy} onClick={installPending} size="xs">
                      Restart
                    </Button>
                  </li>
                ) : null}
              </ul>
            ) : (
              <div className="px-3 py-2 text-muted-foreground">
                No builds waiting. Run <code>fork-app.sh prepare</code> on a branch.
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5">
              <span className="truncate text-muted-foreground">
                {state.checkedAt
                  ? `Checked ${new Date(state.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                  : "Follows origin/fork"}
              </span>
              <Button disabled={isChecking} onClick={check} size="xs" variant="ghost-muted">
                <RefreshCwIcon />
                Check now
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}

function ForkBuildRow({
  build,
  busy,
  confirmDelete,
  onDelete,
  onInstall,
  pending,
}: {
  readonly build: DesktopForkBuild;
  readonly busy: boolean;
  readonly confirmDelete: boolean;
  readonly onDelete: () => void;
  readonly onInstall: () => void;
  readonly pending: boolean;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{build.branch}</div>
        <div className="truncate text-muted-foreground">{describeForkBuild(build)}</div>
      </div>
      {confirmDelete ? (
        <Button disabled={busy} onClick={onDelete} size="xs" variant="destructive-outline">
          Delete?
        </Button>
      ) : (
        <>
          <Button disabled={busy} onClick={onInstall} size="xs">
            {pending ? "Updating…" : "Update"}
          </Button>
          <Button
            aria-label={`Delete the build of ${build.branch}`}
            disabled={busy}
            onClick={onDelete}
            size="icon-xs"
            variant="ghost-muted"
          >
            <Trash2Icon />
          </Button>
        </>
      )}
    </li>
  );
}
