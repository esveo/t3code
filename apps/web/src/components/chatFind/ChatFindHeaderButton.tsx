import { SearchIcon } from "lucide-react";
import { use } from "react";

import { useChatFindStore } from "../../chatFindStore";
import { ChatPaneContext } from "../split/chatPane";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Fork: magnifier in the chat's top-right controls that opens find in thread,
 * the same bar mod+f opens. Pressed while the bar is open in this pane; a
 * second click closes it.
 */
export function ChatFindHeaderButton({ shortcutLabel }: { shortcutLabel: string | null }) {
  const paneId = use(ChatPaneContext);
  const open = useChatFindStore((state) => state.open && state.paneId === paneId);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={(pressed) => {
            const store = useChatFindStore.getState();
            if (pressed) store.show(paneId);
            else store.hide();
          }}
          aria-label="Find in thread"
          variant="ghost"
          size="sm"
        >
          <SearchIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Find in thread{shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
