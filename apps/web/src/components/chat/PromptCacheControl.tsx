import { useEffect, useState } from "react";
import type { PromptCacheWindow } from "@t3tools/contracts";
import { TimerIcon, TimerOffIcon } from "lucide-react";

import {
  formatIdleDuration,
  msUntilPromptCacheStateChanges,
  resolvePromptCacheState,
} from "~/lib/promptCache";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

const TTL_LABEL: Record<PromptCacheWindow["ttl"], string> = {
  "5m": "5 minutes",
  "1h": "1 hour",
};

/**
 * Minutes left before the provider's prompt cache for this thread expires.
 * Re-renders only when the minute count changes, and stops once it is cold.
 */
export function PromptCacheControl(props: {
  promptCache: PromptCacheWindow;
  size?: ComposerControlSize;
}) {
  const size = props.size ?? "sm";
  // Sampled when the minute count changes. A refresh arriving in between reads
  // at most one minute stale and resyncs on the next tick.
  const [now, setNow] = useState(Date.now);
  const state = resolvePromptCacheState(props.promptCache, now);
  const delay = msUntilPromptCacheStateChanges(state);
  useEffect(() => {
    if (delay === null) return;
    const timeout = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timeout);
  }, [delay]);

  const label =
    state.kind === "warm"
      ? `Prompt cache warm, about ${state.minutesLeft} min left`
      : `Prompt cache likely expired, idle ${formatIdleDuration(state.idleMs)}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className={cn("shrink-0 whitespace-nowrap", state.kind === "cold" && "opacity-60")}
            type="button"
            aria-label={label}
            data-chat-prompt-cache-control
          />
        }
      >
        <ComposerControlIcon icon={state.kind === "warm" ? TimerIcon : TimerOffIcon} size={size} />
        {state.kind === "warm" ? (
          <span data-composer-control-label className="tabular-nums">
            {state.minutesLeft}m
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64 whitespace-normal">
        <div className="flex flex-col gap-1">
          <span>{label}.</span>
          <span className="text-muted-foreground">
            {state.kind === "warm"
              ? `Each request keeps the conversation cached for ${TTL_LABEL[props.promptCache.ttl]}.`
              : "Your next message writes the whole conversation into the cache again."}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
