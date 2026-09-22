import { Minimize2Icon } from "lucide-react";
import { useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { ComposerControl, type ComposerControlSize } from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { formatContextWindowCompactionMessage } from "../chat/ContextWindowMeter.logic";
import {
  formatContextWindowPercentage,
  hasContextWindowFill,
  resolveContextWindowLimitPercentage,
  resolveContextWindowTone,
  type ContextWindowTone,
} from "../chat/contextWindowControl.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { contextWindowRows } from "./contextWindowRows";
import { ThreadCostPanel } from "./ThreadCostPanel";

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

type ThreadUsageTab = "context" | "cost";

/**
 * The fork's composer control for what a turn costs, in tokens and in money.
 *
 * Stands in for upstream's `ContextWindowControl` at the composer's one call
 * site rather than wrapping it: the tab switcher belongs inside the popover,
 * and there trigger and popup are one component. Replacing it keeps upstream's
 * file untouched, so its future edits land as a file to read rather than as a
 * merge conflict. The trigger and the context readout are deliberately a copy
 * of upstream's, and upstream's pure helpers are imported, not duplicated.
 */
export function ThreadUsageControl(props: {
  usage: ContextWindowSnapshot;
  /** The thread whose cost the second tab reports. */
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  modelDisplayName?: string | null;
  size?: ComposerControlSize;
  /** Measured but out of flow: close the popup rather than orphaning it. */
  hidden?: boolean;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  // Deliberately not remembered across openings: the cost tab scans
  // transcripts, and a hover should never be enough to start one.
  const [tab, setTab] = useState<ThreadUsageTab>("context");

  const tone = resolveContextWindowTone(usage);
  const showsFill = hasContextWindowFill(usage);
  const fillPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const limitPercentage = resolveContextWindowLimitPercentage(usage);
  const percentageLabel = formatContextWindowPercentage(usage.usedPercentage);
  const tokensLabel = formatContextWindowTokens(usage.usedTokens);

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
        <span
          // A narrow strip drops the number and keeps the fill, the same way
          // the other controls fall back to their icon. Without a fill the
          // number is the whole reading, so it is not offered up.
          data-composer-control-label={showsFill ? "" : undefined}
          className={cn("tabular-nums", toneLabelClassName[tone])}
        >
          {showsFill ? percentageLabel : tokensLabel}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="start"
        viewportClassName="p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <div
          className="flex flex-col gap-2 p-[var(--floating-content-inset)]"
          onMouseDown={(event) => {
            // Keep a tab click from reaching the composer behind the popup.
            event.stopPropagation();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <ToggleGroup
              aria-label="Usage view"
              variant="segmented"
              className="h-auto"
              value={[tab]}
              onValueChange={(next) => {
                const selected = next[0];
                if (selected === "context" || selected === "cost") setTab(selected);
              }}
            >
              <Toggle value="context">Context</Toggle>
              <Toggle value="cost">Cost</Toggle>
            </ToggleGroup>
            <div
              className={cn(
                "text-secondary-label text-[11px] tabular-nums",
                tab === "cost" && "hidden",
              )}
            >
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
          {tab === "cost" ? (
            <ThreadCostPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : (
            <>
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
              <div className="flex flex-col gap-1">
                {contextWindowRows(usage).map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 text-[11px] leading-4"
                  >
                    <span
                      className={cn(
                        "text-secondary-label",
                        row.key === "reasoning" && "ps-2 opacity-80",
                      )}
                    >
                      {row.label}
                    </span>
                    <span className="font-medium tabular-nums text-secondary-label">
                      {formatContextWindowTokens(row.tokens)}
                    </span>
                  </div>
                ))}
              </div>
              {usage.compactsAutomatically ? (
                <div className="mt-1 text-pretty font-medium text-secondary-label text-[11px]">
                  {formatContextWindowCompactionMessage(
                    modelDisplayName,
                    usage.autoCompactThreshold,
                  )}
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
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
