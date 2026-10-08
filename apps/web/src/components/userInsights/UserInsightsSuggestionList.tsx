import type { UserInsightsSuggestion } from "@t3tools/contracts";
import { memo, useEffect, useRef } from "react";

import { useIsActiveChatPane } from "../split/chatPane";

/**
 * Fork: user insights. The suggested next messages, in the look of the ask
 * tool's options: label, description and the 1-3 key that picks it. Picking
 * only fills the composer; nothing is sent.
 */
export const UserInsightsSuggestionList = memo(function UserInsightsSuggestionList({
  suggestions,
  onPick,
}: {
  readonly suggestions: ReadonlyArray<UserInsightsSuggestion>;
  readonly onPick: (index: number) => void;
}) {
  // Same guard as the ask tool: digits pick only outside editable fields,
  // and only in the split pane the user works in.
  const isActivePane = useIsActiveChatPane();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isActivePane || suggestions.length === 0) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > suggestions.length) return;
      // Stacked behind another notice, the options are not on screen.
      const root = rootRef.current;
      if (!root?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
      event.preventDefault();
      onPick(digit - 1);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isActivePane, onPick, suggestions.length]);

  return (
    <div ref={rootRef} className="min-w-0 ps-8 pe-1 pb-1 sm:ps-7">
      <div className="space-y-0.5">
        {suggestions.map((suggestion, index) => (
          <button
            key={`${suggestion.label}\n${suggestion.prompt}`}
            type="button"
            onClick={() => onPick(index)}
            className="group flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2.5 py-2 text-left text-foreground/85 outline-none transition-colors duration-150 hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-primary/25"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium wrap-anywhere">{suggestion.label}</span>
              {suggestion.description && suggestion.description !== suggestion.label ? (
                <span className="text-secondary-label text-2xs wrap-anywhere">
                  {suggestion.description}
                </span>
              ) : null}
            </div>
            <kbd className="flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums">
              {index + 1}
            </kbd>
          </button>
        ))}
      </div>
    </div>
  );
});
