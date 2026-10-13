import { SearchIcon } from "lucide-react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Fork: magnifier in the chat's top-right controls that opens find in thread
 * for its own pane, the same bar mod+f opens. Pressed while the bar is open;
 * a second click closes it.
 */
export function ThreadFindHeaderButton(props: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  shortcutLabel: string | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={props.open}
          onPressedChange={(pressed) => (pressed ? props.onOpen() : props.onClose())}
          aria-label="Find in thread"
          variant="ghost"
          size="sm"
        >
          <SearchIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Find in thread{props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
