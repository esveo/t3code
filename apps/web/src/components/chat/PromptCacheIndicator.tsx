import { TimerIcon, TimerOffIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  derivePromptCacheStatus,
  describePromptCacheStatus,
  formatPromptCacheRemaining,
} from "./PromptCacheIndicator.logic";

/**
 * Countdown until the provider's prompt cache for this thread expires.
 * Re-renders once per second only while counting down; refreshing and expired
 * states hold no timer.
 */
export const PromptCacheIndicator = memo(function PromptCacheIndicator(props: {
  refreshedAt: string;
  ttlSeconds: number;
  turnRunning: boolean;
  compact: boolean;
}) {
  const { refreshedAt, ttlSeconds, turnRunning, compact } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inputKey = `${refreshedAt}|${ttlSeconds}|${turnRunning}`;
  const lastInputKeyRef = useRef(inputKey);

  useEffect(() => {
    // New input renders once with the last tick's clock; re-read it right away.
    const inputChanged = lastInputKeyRef.current !== inputKey;
    lastInputKeyRef.current = inputKey;
    const current = derivePromptCacheStatus({ refreshedAt, ttlSeconds, turnRunning, nowMs });
    if (!inputChanged && current?.kind !== "counting") {
      return;
    }
    const delay =
      inputChanged || current?.kind !== "counting" ? 0 : current.remainingMs % 1000 || 1000;
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [inputKey, refreshedAt, ttlSeconds, turnRunning, nowMs]);

  const status = derivePromptCacheStatus({ refreshedAt, ttlSeconds, turnRunning, nowMs });
  if (!status) {
    return null;
  }

  const description = describePromptCacheStatus(status);
  const label =
    status.kind === "counting"
      ? formatPromptCacheRemaining(status.remainingMs)
      : compact
        ? null
        : status.kind === "refreshing"
          ? "Cache active"
          : "Cache expired";
  const Icon = status.kind === "expired" ? TimerOffIcon : TimerIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="timer"
            aria-label={description}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs tabular-nums",
              status.kind === "counting" && status.warning
                ? "text-warning"
                : status.kind === "expired"
                  ? "text-muted-foreground/60"
                  : "text-muted-foreground",
            )}
          />
        }
      >
        <Icon aria-hidden="true" className="size-3.5" />
        {label ? <span>{label}</span> : null}
      </TooltipTrigger>
      <TooltipPopup
        {...composerFloatingLayerProps}
        side="top"
        className="max-w-64 whitespace-normal"
      >
        {description}
      </TooltipPopup>
    </Tooltip>
  );
});
