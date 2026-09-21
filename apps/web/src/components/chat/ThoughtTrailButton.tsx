import { BrainIcon, RotateCwIcon } from "lucide-react";
import { createContext, memo, use, useMemo, useState } from "react";
import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

import { thoughtTrailEnvironment } from "~/state/thoughtTrail";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { deriveTurnsWithThoughts, type ThoughtEntry, type ThoughtTrail } from "./thoughtSummary";

const ThoughtTurnsCtx = createContext<ReadonlySet<string>>(new Set());

/**
 * Tells each assistant footer whether its turn has thinking to recap.
 *
 * Only membership, never the trace: the timeline re-renders on every streaming
 * frame, and a context value that changed with it would drag every visible row
 * along. The trace stays on the server, which reads it by turn when asked.
 */
export function ThoughtTrailsProvider({
  entries,
  liveTurnId,
  children,
}: {
  entries: ReadonlyArray<ThoughtEntry>;
  liveTurnId: string | null;
  children: React.ReactNode;
}) {
  const derived = useMemo(
    () => deriveTurnsWithThoughts(entries, liveTurnId),
    [entries, liveTurnId],
  );
  const turns = useStableTurnSet(derived);

  return <ThoughtTurnsCtx value={turns}>{children}</ThoughtTurnsCtx>;
}

/** A fresh Set every frame would churn the context; only membership matters. */
function useStableTurnSet(next: ReadonlySet<string>): ReadonlySet<string> {
  const [stable, setStable] = useState(next);
  const value = sameMembers(stable, next) ? stable : next;
  if (value !== stable) {
    setStable(value);
  }
  return value;
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const member of left) {
    if (!right.has(member)) return false;
  }
  return true;
}

type TrailState =
  | { readonly key: string; readonly status: "idle" }
  | { readonly key: string; readonly status: "pending" }
  | {
      readonly key: string;
      readonly status: "ready";
      readonly trail: ThoughtTrail;
      readonly model: string;
    }
  | { readonly key: string; readonly status: "error"; readonly detail: string };

const TRIGGER_LABEL = "Recap the thinking";

/**
 * Sits with copy and the timestamp under an answer: the same footer you reach
 * for once the turn is done. Absent when the turn did not think, or while it
 * still is. The recap is asked for, never produced with the turn, and it is
 * kept for the session rather than stored with the thread.
 */
export const ThoughtTrailButton = memo(function ThoughtTrailButton({
  turnId,
  threadRef,
}: {
  turnId: TurnId | null;
  threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}) {
  const turns = use(ThoughtTurnsCtx);
  const summarize = useAtomCommand(thoughtTrailEnvironment.summarize, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TrailState>({ key: turnId ?? "", status: "idle" });

  // A recap belongs to the turn it was made from, so a row recycled onto
  // another turn starts over. Derived here so no effect has to chase the prop.
  const current: TrailState = state.key === turnId ? state : { key: turnId ?? "", status: "idle" };

  if (turnId === null || threadRef === null || !turns.has(turnId)) {
    return null;
  }

  const generate = () => {
    setState({ key: turnId, status: "pending" });
    void summarize({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, turnId },
    }).then((result) => {
      setState(
        result._tag === "Success"
          ? {
              key: turnId,
              status: "ready",
              trail: { steps: result.value.steps, outcome: result.value.outcome },
              model: result.value.model,
            }
          : { key: turnId, status: "error", detail: describeFailure(result) },
      );
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && current.status === "idle") {
          generate();
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={TRIGGER_LABEL}
                  className="text-muted-foreground hover:text-foreground"
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
        viewportClassName="p-0"
        className="w-80 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Thought trail</div>
            {current.status === "ready" || current.status === "error" ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Recap again"
                onClick={generate}
                className="-me-1 text-secondary-label"
              >
                <RotateCwIcon aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {current.status === "ready" ? (
            <ThoughtTrailBody trail={current.trail} />
          ) : current.status === "error" ? (
            <div className="text-pretty text-[11px] text-error leading-4">{current.detail}</div>
          ) : (
            <div className="flex items-center gap-2 py-1 text-secondary-label text-[11px]">
              <Spinner className="size-3.5" />
              Reading back the thinking
            </div>
          )}
          {current.status === "ready" ? (
            <div className="text-secondary-label text-[11px] opacity-70">
              Summarized by {current.model}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

function describeFailure(result: { readonly cause: Cause.Cause<unknown> }) {
  const error: unknown = squashAtomCommandFailure(result);
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "detail" in error
        ? String((error as { detail: unknown }).detail)
        : null;
  return detail && detail.length > 0
    ? detail
    : "Could not recap the thinking. The server may not support it yet.";
}

function ThoughtTrailBody({ trail }: { trail: ThoughtTrail }) {
  if (trail.steps.length === 0 && trail.outcome === null) {
    return <div className="text-secondary-label text-[11px]">Nothing readable in this trace.</div>;
  }

  return (
    // A long turn outruns the popup, so the trail scrolls inside it rather
    // than pushing the footer off the screen.
    <div className="-me-1 flex max-h-56 flex-col gap-2 overflow-y-auto overscroll-contain pe-1">
      {trail.steps.length > 0 ? (
        <ol className="relative ms-[3px] flex flex-col gap-2 border-border border-s ps-4">
          {trail.steps.map((step) => (
            <li key={step} className="relative text-[11px] leading-4">
              <span
                aria-hidden="true"
                // Centred on the rail, which sits one padding step before the
                // text: offset by the padding too, or the dot lands on the
                // first letter.
                className="-start-[calc(1rem+0.1875rem+1px)] absolute top-1.5 size-1.5 rounded-full bg-muted-foreground/60"
              />
              {step}
            </li>
          ))}
        </ol>
      ) : null}
      {trail.outcome !== null ? (
        <div className="text-pretty font-medium text-[11px] leading-4 text-secondary-label">
          {trail.outcome}
        </div>
      ) : null}
    </div>
  );
}
