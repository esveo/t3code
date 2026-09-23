import type { ChildThreadState } from "@t3tools/shared/threadOrchestration";

/**
 * The status dot of a child thread, in the colors the sidebar already uses:
 * amber waits on the user, blue works, green is ready for review.
 */
export const CHILD_THREAD_DOT_CLASS: Record<ChildThreadState, string> = {
  waiting: "bg-amber-500 dark:bg-amber-400",
  failed: "bg-destructive",
  working: "bg-blue-500 dark:bg-blue-400",
  review: "bg-success",
  stopped: "bg-muted-foreground/50",
  done: "bg-muted-foreground/50",
};
