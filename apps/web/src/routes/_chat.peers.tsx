import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PeersView } from "../components/peers/PeersView";

export interface PeersSearch {
  readonly contact?: string;
}

export const Route = createFileRoute("/_chat/peers")({
  validateSearch: (raw: Record<string, unknown>): PeersSearch =>
    typeof raw.contact === "string" && raw.contact ? { contact: raw.contact.slice(0, 200) } : {},
  component: PeersRouteView,
});

function PeersRouteView() {
  const { contact } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <PeersView
      contactId={contact ?? null}
      onSelectContact={(next) =>
        void navigate({ to: "/peers", search: { contact: next }, replace: true })
      }
    />
  );
}
