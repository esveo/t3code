import { BrainIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { TurnId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { deriveThoughtTrail, type ThoughtTrail } from "./thoughtSummary";
import { readTimelineThoughts, useTimelineThoughtTurns } from "./thoughtTrailStore";

const TRIGGER_LABEL = "Read back the thinking";

/**
 * Sits with copy and the timestamp under an answer: the same footer you reach
 * for once the turn is done. Absent when the turn did not think, or while it
 * still is. The trail is built on open, from the trace the client already
 * holds, so it costs nothing and is there in the first frame.
 */
export const ThoughtTrailButton = memo(function ThoughtTrailButton({
  turnId,
  timelineKey,
}: {
  turnId: TurnId | null;
  timelineKey: string | null;
}) {
  const turns = useTimelineThoughtTurns(timelineKey);
  const [open, setOpen] = useState(false);

  if (turnId === null || timelineKey === null || !turns.has(turnId)) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={TRIGGER_LABEL}
                  data-chat-thought-trail-button
                />
              }
            />
          }
        >
          <BrainIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          <p>{TRIGGER_LABEL}</p>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        tooltipStyle
        side="top"
        align="start"
        // Upstream #13193 replaces viewportClassName with a padding prop; after
        // that sync this becomes padding="none" (same look: no inner padding).
        viewportClassName="p-0"
        // Wide enough for whole sentences: a trail of clipped fragments reads
        // worse than the trace it stands in for.
        className="w-[min(40rem,calc(100vw-2rem))] max-w-none text-left whitespace-normal"
      >
        {open ? <ThoughtTrailContent timelineKey={timelineKey} turnId={turnId} /> : null}
      </PopoverPopup>
    </Popover>
  );
});

function ThoughtTrailContent({ timelineKey, turnId }: { timelineKey: string; turnId: TurnId }) {
  const trail = useMemo(
    () => deriveThoughtTrail(readTimelineThoughts(timelineKey, turnId)),
    [timelineKey, turnId],
  );

  return (
    <div className="flex flex-col gap-2.5 p-[var(--floating-content-inset)]">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Thought trail</div>
        <div className="text-secondary-label text-[11px] tabular-nums">
          {trail.steps.length === 1 ? "1 step" : `${trail.steps.length} steps`}
        </div>
      </div>
      <ThoughtTrailBody trail={trail} />
    </div>
  );
}

function ThoughtTrailBody({ trail }: { trail: ThoughtTrail }) {
  if (trail.steps.length === 0) {
    return <div className="text-secondary-label text-xs">Nothing readable in this trace.</div>;
  }

  return (
    // A long turn outruns the popup, so the trail scrolls inside it rather
    // than running past the screen.
    <div className="-me-1 max-h-[min(28rem,60vh)] overflow-y-auto overscroll-contain pe-1">
      <ol className="relative ms-[3px] flex flex-col gap-2.5 border-border border-s ps-4">
        {trail.steps.map((step) => (
          <li key={step} className="relative text-pretty text-foreground/90 text-xs leading-5">
            <span
              aria-hidden="true"
              // Centred on the rail, which sits one padding step before the
              // text: offset by the padding too, or the dot lands on the
              // first letter.
              className="-start-[calc(1rem+0.1875rem+1px)] absolute top-2 size-1.5 rounded-full bg-muted-foreground/60"
            />
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}
