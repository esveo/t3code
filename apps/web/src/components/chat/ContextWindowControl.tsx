import { Minimize2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import {
  formatContextWindowPercentage,
  hasContextWindowFill,
  resolveContextWindowLimitPercentage,
  resolveContextWindowTone,
  type ContextWindowTone,
} from "./contextWindowControl.logic";

const toneFillClassName: Record<ContextWindowTone, string> = {
  normal: "bg-muted-foreground/70",
  warning: "bg-warning",
  critical: "bg-error",
};

const toneLabelClassName: Record<ContextWindowTone, string> = {
  normal: "",
  critical: "text-error",
  warning: "text-warning",
};

/**
 * The fill the user reads at a glance, and the popover behind it.
 *
 * The bar is drawn against the window while the marker shows where the
 * provider compacts, so a thread that is one turn from losing its history
 * looks urgent even at half the window. Sits with the model, reasoning and
 * access controls rather than beside the send button, because it belongs to
 * the same "what is this turn going to be" reading.
 */
export function ContextWindowControl(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  size?: ComposerControlSize;
  /** Measured but out of flow: close the popup rather than orphaning it. */
  hidden?: boolean;
  /** Narrow footers keep the bar and drop the number. */
  showPercentage?: boolean;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const size = props.size ?? "sm";
  const showPercentage = props.showPercentage ?? true;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);

  const tone = resolveContextWindowTone(usage);
  const showsFill = hasContextWindowFill(usage);
  const fillPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const limitPercentage = resolveContextWindowLimitPercentage(usage);
  const percentageLabel = formatContextWindowPercentage(usage.usedPercentage);
  const tokensLabel = formatContextWindowTokens(usage.usedTokens);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const remainingTokens = usage.remainingTokens ?? null;

  const triggerLabel = showsFill
    ? `Context window ${percentageLabel} used, ${tokensLabel} of ${formatContextWindowTokens(usage.maxTokens ?? null)} tokens`
    : `Context window ${tokensLabel} tokens used`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <ComposerControl
            size={size}
            className="shrink-0 gap-1.5 whitespace-nowrap"
            type="button"
            aria-label={triggerLabel}
            data-chat-context-window-control
          />
        }
      >
        {showsFill ? (
          <span
            className={cn(
              "relative shrink-0 overflow-hidden rounded-full bg-muted-foreground/25",
              size === "xs" ? "h-1 w-6" : "h-1.5 w-8",
            )}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fillPercentage)}
            aria-label="Context window usage"
          >
            <span
              className={cn(
                "block h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                toneFillClassName[tone],
              )}
              style={{ width: `${fillPercentage}%` }}
            />
            {limitPercentage !== null ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 w-px bg-background/80"
                style={{ left: `${limitPercentage}%` }}
              />
            ) : null}
          </span>
        ) : null}
        {showPercentage || !showsFill ? (
          <span className={cn("tabular-nums", toneLabelClassName[tone])}>
            {showsFill ? percentageLabel : tokensLabel}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="start"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            <div className="text-secondary-label text-[11px] tabular-nums">
              {showsFill ? (
                <>
                  <span>{percentageLabel}</span>
                  <span className="mx-1">·</span>
                  <span>
                    {tokensLabel}/{formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </>
              ) : (
                tokensLabel
              )}
            </div>
          </div>
          {showsFill ? (
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  toneFillClassName[tone],
                )}
                style={{ width: `${fillPercentage}%` }}
              />
              {limitPercentage !== null ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 w-px bg-background/80"
                  style={{ left: `${limitPercentage}%` }}
                />
              ) : null}
            </div>
          ) : null}
          {remainingTokens !== null ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Remaining</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(remainingTokens)}
              </span>
            </div>
          ) : null}
          {totalProcessedTokens !== null && totalProcessedTokens > 0 ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty font-medium text-secondary-label text-[11px]">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
