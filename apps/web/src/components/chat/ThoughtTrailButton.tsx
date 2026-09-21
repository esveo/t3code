import { BrainIcon, RotateCwIcon } from "lucide-react";
import { createContext, memo, use, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveTurnsWithThoughts,
  generateStubThoughtTrail,
  readTurnThoughts,
  type ThoughtEntry,
  type ThoughtTrail,
} from "./thoughtSummary";

interface ThoughtTrails {
  readonly turns: ReadonlySet<string>;
  readonly read: (turnId: string) => string;
}

const EMPTY_THOUGHT_TRAILS: ThoughtTrails = { turns: new Set(), read: () => "" };
const ThoughtTrailsCtx = createContext<ThoughtTrails>(EMPTY_THOUGHT_TRAILS);

/**
 * Makes each turn's thinking reachable from its assistant footer.
 *
 * The trace itself is read on demand from a ref rather than carried in the
 * context: the timeline re-renders on every streaming frame, and a context
 * value that changed with it would drag every visible row along.
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
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const derived = useMemo(
    () => deriveTurnsWithThoughts(entries, liveTurnId),
    [entries, liveTurnId],
  );
  const turns = useStableTurnSet(derived);
  const value = useMemo<ThoughtTrails>(
    () => ({ turns, read: (turnId) => readTurnThoughts(entriesRef.current, turnId) }),
    [turns],
  );

  return <ThoughtTrailsCtx value={value}>{children}</ThoughtTrailsCtx>;
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
  | { readonly key: string; readonly status: "ready"; readonly trail: ThoughtTrail };

const TRIGGER_LABEL = "Recap the thinking";

/**
 * Sits with copy and the timestamp under an answer: the same footer you reach
 * for once the turn is done. Absent when the turn did not think, or while it
 * still is. The recap is asked for, never computed on its own, and lives only
 * for the session.
 */
export const ThoughtTrailButton = memo(function ThoughtTrailButton({
  turnId,
}: {
  turnId: string | null;
}) {
  const trails = use(ThoughtTrailsCtx);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TrailState>({ key: turnId ?? "", status: "idle" });
  const runIdRef = useRef(0);

  // A recap belongs to the turn it was made from, so a row recycled onto
  // another turn starts over. Derived here so no effect has to chase the prop.
  const current: TrailState = state.key === turnId ? state : { key: turnId ?? "", status: "idle" };

  if (turnId === null || !trails.turns.has(turnId)) {
    return null;
  }

  const generate = () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setState({ key: turnId, status: "pending" });
    void generateStubThoughtTrail(trails.read(turnId)).then((trail) => {
      if (runIdRef.current === runId) {
        setState({ key: turnId, status: "ready", trail });
      }
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
            {current.status === "ready" ? (
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
          ) : (
            <div className="flex items-center gap-2 py-1 text-secondary-label text-[11px]">
              <Spinner className="size-3.5" />
              Reading back the thinking
            </div>
          )}
          <div className="text-pretty text-secondary-label text-[11px] opacity-70">
            Prototype: assembled locally, no model call yet.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

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
