import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { InitiativesPage } from "../components/initiatives/InitiativesPage";

/** Fork: the Initiatives page; `id` opens one initiative, `view=inbox` the Inbox over all. */
export interface InitiativesSearch {
  readonly id?: string;
  readonly environmentId?: EnvironmentId;
  readonly view?: "inbox";
}

export const Route = createFileRoute("/_chat/initiatives")({
  validateSearch: (raw: Record<string, unknown>): InitiativesSearch => ({
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id.slice(0, 200) } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(raw.view === "inbox" ? { view: "inbox" as const } : {}),
  }),
  component: InitiativesRouteView,
});

function InitiativesRouteView() {
  const { id, environmentId, view } = Route.useSearch();
  return (
    <InitiativesPage
      initiativeId={id}
      environmentId={environmentId}
      view={view === "inbox" ? "inbox" : "list"}
    />
  );
}
