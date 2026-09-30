/**
 * Fork: one decision to answer or task to check off. The question, its
 * explanation, the options as boxes with the recommended one marked, and a
 * free-text box as the last answer: a note to the chosen option, an own
 * answer, or a question back to the coordinator. A task has a checkbox box
 * instead of options.
 */
import type { ScopedThreadRef, ThreadDecision } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";
import type { DecisionDraft } from "./threadInbox.logic";

export interface DecisionCardProps {
  readonly decision: ThreadDecision;
  readonly draft: DecisionDraft | undefined;
  readonly coordinatorRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly dependencies: ReadonlyArray<ThreadDecision>;
  readonly onDraft: (patch: Partial<DecisionDraft> | null) => void;
}

const answerBox =
  "grid w-full cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)] items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

export function DecisionCard(props: DecisionCardProps) {
  const { decision, draft } = props;
  const task = decision.kind === "task";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold leading-snug text-balance">{decision.question}</h3>
        {decision.context ? (
          <div className="text-sm text-muted-foreground">
            <ChatMarkdown
              text={decision.context}
              cwd={props.cwd}
              threadRef={props.coordinatorRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {task ? (
          <label
            className={cn(
              answerBox,
              draft?.done ? "border-primary" : "border-input hover:border-muted-foreground/40",
            )}
          >
            <Checkbox
              checked={draft?.done === true}
              onCheckedChange={(checked) => props.onDraft({ done: checked === true })}
            />
            <span className="font-medium">Done</span>
          </label>
        ) : null}

        <div role="radiogroup" aria-label={decision.title} className="flex flex-col gap-2">
          {decision.options.map((option) => {
            const selected = draft?.optionId === option.id;
            const recommended = decision.recommendedOptionId === option.id;
            const detail = [option.detail, recommended ? decision.recommendationReason : null]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => props.onDraft({ optionId: selected ? undefined : option.id })}
                className={cn(
                  answerBox,
                  selected ? "border-primary" : "border-input hover:border-muted-foreground/40",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-3.5 rounded-full border-2",
                    selected ? "border-4 border-primary" : "border-muted-foreground/60",
                  )}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {option.label}
                    {recommended ? (
                      <span className="font-normal text-muted-foreground"> (recommended)</span>
                    ) : null}
                  </span>
                  {detail ? <span className="text-muted-foreground">{detail}</span> : null}
                </span>
              </button>
            );
          })}
        </div>

        <textarea
          rows={3}
          data-inbox-note={decision.id}
          aria-label="Your own answer or a note"
          value={draft?.text ?? ""}
          placeholder={
            draft?.optionId || draft?.done
              ? "A note to your answer"
              : "Your own answer, a question back, or a note"
          }
          onChange={(event) => props.onDraft({ text: event.target.value })}
          className={cn(
            "w-full resize-none rounded-lg border border-dashed bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-solid focus-visible:border-primary",
            draft?.text ? "border-solid border-primary" : "border-input",
          )}
        />
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
