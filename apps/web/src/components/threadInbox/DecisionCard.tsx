/**
 * Fork: one decision to answer. The options are a choice list with the
 * coordinator's recommendation and its reason on the recommended option; a
 * note, pros and cons and the rarer actions stay folded until asked for.
 */
import type { ScopedThreadRef, ThreadDecision, ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleHelpIcon,
  ClockIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PencilLineIcon,
  ScaleIcon,
  SendIcon,
} from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { type DecisionDraft, URGENCY_LABELS } from "./threadInbox.logic";

export interface DecisionCardProps {
  readonly decision: ThreadDecision;
  readonly draft: DecisionDraft | undefined;
  /** Focus shows the title and meta line the list row already shows. */
  readonly mode: "list" | "focus";
  readonly coordinatorRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly threadTitle: (threadId: ThreadId) => string | null;
  readonly dependencies: ReadonlyArray<ThreadDecision>;
  readonly noteOpen: boolean;
  readonly onNoteOpenChange: (open: boolean) => void;
  readonly onDraft: (patch: Partial<DecisionDraft> | null) => void;
  readonly onSendNow: () => void;
  readonly onSnooze: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

export function DecisionCard(props: DecisionCardProps) {
  const { decision, draft } = props;
  const [showProsCons, setShowProsCons] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const hasProsCons = decision.options.some(
    (option) => option.pros.length > 0 || option.cons.length > 0,
  );
  const noteOpen = props.noteOpen || (draft?.text?.length ?? 0) > 0;
  const source = decision.sourceThreadId ? props.threadTitle(decision.sourceThreadId) : null;
  const route =
    decision.routeToThreadId && decision.routeToThreadId !== decision.sourceThreadId
      ? props.threadTitle(decision.routeToThreadId)
      : null;

  return (
    <div className="flex flex-col gap-2.5">
      {props.mode === "focus" ? (
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold leading-snug text-balance">{decision.title}</h3>
          <p className="text-xs text-muted-foreground">
            {[
              source ?? "Coordinator",
              route ? `→ ${route}` : null,
              URGENCY_LABELS[decision.urgency],
            ]
              .filter(Boolean)
              .join(" · ")}
            {decision.askedBackAt ? " · you asked back" : ""}
          </p>
        </div>
      ) : null}
      <p className="text-sm leading-relaxed">{decision.question}</p>
      {decision.context ? (
        <div className="rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs">
          <ChatMarkdown
            text={decision.context}
            cwd={props.cwd}
            threadRef={props.coordinatorRef}
            isStreaming={false}
            headingLevelOffset={3}
          />
        </div>
      ) : null}

      <div role="radiogroup" aria-label={decision.title} className="flex flex-col gap-1.5">
        {decision.options.map((option, index) => {
          const selected = draft?.optionId === option.id;
          const recommended = decision.recommendedOptionId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onDraft({ optionId: selected ? undefined : option.id })}
              className={cn(
                "grid w-full cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary bg-primary/10"
                  : "border-input bg-accent/40 hover:border-muted-foreground/40",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 size-3.5 rounded-full border-[1.5px]",
                  selected ? "border-[4px] border-primary" : "border-muted-foreground/60",
                )}
              />
              <span className="flex min-w-0 flex-col">
                <span>
                  {index < 9 ? (
                    <span className="mr-1.5 font-mono text-[10.5px] text-muted-foreground">
                      {index + 1}
                    </span>
                  ) : null}
                  {option.label}
                </span>
                {option.detail ? (
                  <span className="text-xs text-muted-foreground">{option.detail}</span>
                ) : null}
                {recommended && decision.recommendationReason ? (
                  <span className="mt-0.5 text-xs text-foreground/80">
                    {decision.recommendationReason}
                  </span>
                ) : null}
              </span>
              {recommended ? (
                <span className="pt-0.5 text-[10px] font-semibold tracking-wide text-primary uppercase">
                  Recommended
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {draft?.askBack ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleHelpIcon aria-hidden className="size-3.5" />
          You ask the coordinator for pros and cons.
          <Button
            size="micro"
            variant="ghost-muted"
            onClick={() => props.onDraft({ askBack: false })}
          >
            Undo
          </Button>
        </p>
      ) : null}
      {draft?.dismissReason !== undefined ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckIcon aria-hidden className="size-3.5" />
          Done{draft.dismissReason ? `: ${draft.dismissReason}` : ""}
          <Button
            size="micro"
            variant="ghost-muted"
            onClick={() => props.onDraft({ dismissReason: undefined })}
          >
            Undo
          </Button>
        </p>
      ) : null}

      {showProsCons && hasProsCons ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-1.5">
          {decision.options.map((option) => (
            <div
              key={option.id}
              className="rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs"
            >
              <p className="mb-0.5 font-medium">{option.label}</p>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {option.pros.map((pro) => (
                  <li key={`pro-${pro}`}>
                    <span className="text-success-foreground">+</span> {pro}
                  </li>
                ))}
                {option.cons.map((con) => (
                  <li key={`con-${con}`}>
                    <span className="text-destructive-foreground">–</span> {con}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {noteOpen ? (
        <Textarea
          size="sm"
          data-inbox-note={decision.id}
          value={draft?.text ?? ""}
          placeholder={
            draft?.optionId ? "Reason or context for the coordinator" : "Your own answer"
          }
          onChange={(event) => props.onDraft({ text: event.target.value })}
        />
      ) : null}

      {dismissing ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            props.onDraft({ dismissReason: dismissReason.trim() });
            setDismissing(false);
            setDismissReason("");
          }}
        >
          <input
            autoFocus
            value={dismissReason}
            onChange={(event) => setDismissReason(event.target.value)}
            placeholder="Done because …"
            aria-label="Why it is done"
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="xs" variant="outline">
            Mark done
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => setDismissing(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      <div className="flex items-center gap-0.5">
        <Button
          size="xs"
          variant="ghost-muted"
          aria-pressed={noteOpen}
          onClick={() => props.onNoteOpenChange(!noteOpen)}
        >
          <PencilLineIcon />
          Note
        </Button>
        {hasProsCons ? (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-pressed={showProsCons}
            onClick={() => setShowProsCons((value) => !value)}
          >
            <ScaleIcon />
            Pros/cons
          </Button>
        ) : null}
        <span className="flex-1" />
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost-muted" aria-label="More actions" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => props.onDraft({ askBack: !draft?.askBack })}>
              <CircleHelpIcon />
              {draft?.askBack ? "Don't ask back" : "Ask back for pros and cons"}
            </MenuItem>
            <MenuItem disabled={!draft} onClick={props.onSendNow}>
              <SendIcon />
              Send this one now
            </MenuItem>
            {decision.sourceThreadId ? (
              <MenuItem onClick={() => props.onOpenThread(decision.sourceThreadId!)}>
                <ExternalLinkIcon />
                Open {source ?? "its thread"}
              </MenuItem>
            ) : null}
            <MenuItem onClick={props.onSnooze}>
              <ClockIcon />
              Snooze until the next update
            </MenuItem>
            <MenuItem onClick={() => setDismissing(true)}>
              <CheckIcon />
              Done because …
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {props.dependencies.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Depends on:{" "}
          {props.dependencies
            .map((dependency) => `${dependency.title} (${dependency.status})`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}
