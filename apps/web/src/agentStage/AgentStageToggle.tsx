import { OrbitIcon } from "lucide-react";
import { useContext } from "react";

import { ChatPaneContext } from "../components/split/chatPane";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useAgentStageStore } from "./agentStageStore";

/** The header button that switches a chat pane between the chat and the stage. */
export function AgentStageToggle() {
  const paneId = useContext(ChatPaneContext);
  const enabled = useAgentStageStore((state) => state.enabled);
  const open = useAgentStageStore((state) => state.openByPane[paneId] === true);
  const toggleOpen = useAgentStageStore((state) => state.toggleOpen);
  if (!enabled) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={() => toggleOpen(paneId)}
          aria-label="Toggle agent stage"
          variant="ghost"
          size="sm"
        >
          <OrbitIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {open ? "Back to the chat" : "Show the agent stage"}
      </TooltipPopup>
    </Tooltip>
  );
}
