import { isIdleAutoCompactMessageId } from "@t3tools/contracts";
import { TimerResetIcon } from "lucide-react";

import { TimelineSystemDivider } from "../chat/TimelineSystemDivider";

/** Fork: the server's idle `/compact` shows as a divider, not as a message the user sent. */
export function isIdleAutoCompactMessage(message: { readonly id: string }): boolean {
  return isIdleAutoCompactMessageId(message.id);
}

export function IdleAutoCompactTimelineRow() {
  return (
    <TimelineSystemDivider
      label="Auto-compact after idle"
      detail="sent before the prompt cache expired"
      icon={TimerResetIcon}
    />
  );
}
