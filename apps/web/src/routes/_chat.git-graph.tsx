import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { useServerConfigs } from "../state/entities";
import { GitGraphView } from "../components/gitGraph/GitGraphView";

export interface GitGraphSearch {
  readonly environmentId?: EnvironmentId;
  readonly cwd?: string;
  /** Repository label for the header, usually the project name. */
  readonly title?: string;
}

export const Route = createFileRoute("/_chat/git-graph")({
  validateSearch: (raw: Record<string, unknown>): GitGraphSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd.slice(0, 4096) } : {}),
    ...(typeof raw.title === "string" && raw.title ? { title: raw.title.slice(0, 200) } : {}),
  }),
  component: GitGraphRouteView,
});

function GitGraphRouteView() {
  const { environmentId, cwd, title } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const serverConfig = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));

  // Escape leaves the view the same way the close button does: back to
  // wherever it was opened from, or to the thread list when opened by URL.
  const close = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/", replace: true });
  };

  const onEscape = useEffectEvent(() => close());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!environmentId || !cwd) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Open the Git graph from a thread so it knows which repository to read.
      </div>
    );
  }

  // Reachable by URL or a stale link even though the entry points hide
  // themselves; saying so beats a failing request the user cannot place.
  if (serverConfig && serverConfig.environment.capabilities.commitGraph !== true) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This server is too old for the Git graph. Update the server that hosts this project, then
        reopen the view.
      </div>
    );
  }

  return (
    <GitGraphView environmentId={environmentId} cwd={cwd} title={title ?? cwd} onClose={close} />
  );
}
