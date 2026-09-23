import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Fork: an agent row that opens the agent's chat. It reads as navigation (a
 * framed row with a trailing chevron that lifts on hover) so it is clear the
 * row leads somewhere, unlike the plain rows of agents that cannot be opened.
 */
export function SubagentChatLink({
  onOpen,
  children,
}: {
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/agent-link my-1 flex w-full cursor-pointer items-center gap-1 rounded-lg border border-border/60 bg-card/40 pe-1.5 text-left transition-colors hover:border-border hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1">{children}</div>
      <ChevronRight
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover/agent-link:text-foreground"
      />
    </button>
  );
}
