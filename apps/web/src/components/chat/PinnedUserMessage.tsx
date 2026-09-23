import { plainTextOfThreadMessage } from "@t3tools/shared/threadOrchestration";
import { ArrowUpIcon } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Index of the user message whose turn the reader is in: the last one that has
 * scrolled fully past the top edge. `null` while that prompt is still on
 * screen, so the pinned header only stands in for a message you can no longer
 * see. Bounds come from the minimap's per-user-message measurements, so they
 * share the virtualizer's row geometry.
 */
export function resolvePinnedUserMessageIndex(input: {
  readonly scrollTop: number;
  readonly itemBounds: ReadonlyArray<{
    readonly top: number | null;
    readonly height: number | null;
  }>;
}): number | null {
  let pinnedIndex: number | null = null;

  for (const [index, bounds] of input.itemBounds.entries()) {
    if (bounds.top === null) {
      continue;
    }
    if (bounds.top + Math.max(1, bounds.height ?? 1) > input.scrollTop) {
      // Rows are ordered, so the first one reaching into the viewport ends it.
      break;
    }
    pinnedIndex = index;
  }

  return pinnedIndex;
}

/** Collapses a prompt to the single flowing line the header has room for. */
export function compactPinnedUserMessageText(text: string | null | undefined): string | null {
  // Thread orchestration messages carry tags the preview must not show.
  const compact = text ? plainTextOfThreadMessage(text).replace(/\s+/g, " ").trim() : "";
  return compact.length > 0 ? compact : null;
}

/**
 * Restates the current turn's prompt at the top of the timeline once the
 * message itself has scrolled away. Glass instead of the message surface: it
 * is chrome over the list, not another bubble in it.
 */
export function PinnedUserMessage({
  text,
  className,
  onSelect,
}: {
  text: string;
  className?: string;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-3 pt-2 sm:px-5",
        className,
      )}
      data-pinned-user-message="true"
    >
      <div className="flex w-full max-w-3xl justify-end">
        <button
          type="button"
          onClick={onSelect}
          aria-label="Scroll to your message"
          className="surface-glass pointer-events-auto flex max-w-[80%] items-start gap-2 rounded-2xl border border-border/60 px-3 py-2 text-left text-sm text-foreground shadow-sm transition-colors hover:border-border"
        >
          <ArrowUpIcon
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="line-clamp-2 min-w-0 break-words">{text}</span>
        </button>
      </div>
    </div>
  );
}
