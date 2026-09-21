import { BrainIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import {
  generateStubThoughtTrail,
  type ThoughtTrail,
  type ThoughtTrailSource,
} from "./thoughtSummary";

type TrailState =
  | { readonly key: string; readonly status: "idle" }
  | { readonly key: string; readonly status: "pending" }
  | { readonly key: string; readonly status: "ready"; readonly trail: ThoughtTrail };

const TRIGGER_LABEL = "Recap the thinking";

/**
 * Sits beside the context window, because both answer the same question about
 * the turn that just finished: what did it cost, and what went on in there.
 * The recap is asked for, never computed on its own, and lives only for the
 * session.
 */
export function ThoughtSummaryControl(props: {
  source: ThoughtTrailSource;
  size?: ComposerControlSize;
  /** Measured but out of flow: close the popup rather than orphaning it. */
  hidden?: boolean;
}) {
  const { source } = props;
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [state, setState] = useState<TrailState>({ key: source.key, status: "idle" });
  const runIdRef = useRef(0);

  // A new turn drops the previous recap rather than showing it against the
  // wrong prompt. Derived here so no effect has to chase the prop.
  const current: TrailState =
    state.key === source.key ? state : { key: source.key, status: "idle" };

  const generate = useCallback(() => {
    const key = source.key;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setState({ key, status: "pending" });
    void generateStubThoughtTrail(source.text).then((trail) => {
      if (runIdRef.current === runId) {
        setState({ key, status: "ready", trail });
      }
    });
  }, [source]);

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
                <ComposerControl
                  size={size}
                  className="shrink-0"
                  type="button"
                  aria-label={TRIGGER_LABEL}
                  data-chat-thought-summary-control
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={BrainIcon} size={size} />
        </TooltipTrigger>
        <TooltipPopup side="top">{TRIGGER_LABEL}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerFloatingLayerProps}
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
}

function ThoughtTrailBody({ trail }: { trail: ThoughtTrail }) {
  if (trail.steps.length === 0 && trail.outcome === null) {
    return <div className="text-secondary-label text-[11px]">Nothing readable in this trace.</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {trail.steps.length > 0 ? (
        <ol className="relative ms-[3px] flex flex-col gap-2 border-border border-s ps-3">
          {trail.steps.map((step) => (
            <li key={step} className="relative text-[11px] leading-4">
              <span
                aria-hidden="true"
                className="-start-[calc(0.1875rem+1px)] absolute top-1.5 size-1.5 rounded-full bg-muted-foreground/60"
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
