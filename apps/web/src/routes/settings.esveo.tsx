import { createFileRoute } from "@tanstack/react-router";

import { EsveoSettingsPanel } from "../components/esveoSettings/EsveoSettingsPanel";

// Fork: esveo's own settings page.
function SettingsEsveoRoute() {
  return <EsveoSettingsPanel />;
}

export const Route = createFileRoute("/settings/esveo")({
  component: SettingsEsveoRoute,
});
