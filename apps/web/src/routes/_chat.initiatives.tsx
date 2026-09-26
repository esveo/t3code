import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { InitiativesPage } from "../components/initiatives/InitiativesPage";

/** Fork: the Initiatives page; `id` opens one initiative. */
export interface InitiativesSearch {
  readonly id?: string;
  readonly environmentId?: EnvironmentId;
}

export const Route = createFileRoute("/_chat/initiatives")({
  validateSearch: (raw: Record<string, unknown>): InitiativesSearch => ({
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id.slice(0, 200) } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
  }),
  component: InitiativesRouteView,
});

function InitiativesRouteView() {
  const { id, environmentId } = Route.useSearch();
  return <InitiativesPage initiativeId={id} environmentId={environmentId} />;
}
