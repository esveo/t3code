/**
 * Fork: the sidebar footer's entry to the Initiatives page, shown while a
 * connected server keeps initiatives. Same shape as the footer's other items.
 */
import { useNavigate } from "@tanstack/react-router";
import { FlagIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useInitiativeEnvironments } from "./InitiativesPage";

export function InitiativesSidebarItem({ onNavigate }: { readonly onNavigate: () => void }) {
  const navigate = useNavigate();
  const supported = useInitiativeEnvironments();
  if (supported.length === 0) return null;
  const label = "Vorhaben";
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={() => {
                onNavigate();
                void navigate({ to: "/initiatives", search: {} });
              }}
              size="icon"
            >
              <FlagIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
