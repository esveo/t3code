import type { SidebarThreadSummary } from "../../types";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { SidebarThreadStatus } from "../Sidebar.logic";

/**
 * Fork: a turn that completes but leaves a command running (a dev server, a
 * watcher) parks the thread at "waiting", which reads as background presence
 * and recedes, so the finished thread is easy to miss. Until it has been seen,
 * it reads as ready instead, which the sidebar shows as Done. Subagents and
 * monitors still wake the agent, so they keep it waiting, the same rule the
 * completion notification follows.
 */
export function resolveDoneWhileWaitingStatus(
  status: SidebarThreadStatus,
  thread: Pick<SidebarThreadSummary, "latestRun" | "pendingBackgroundTasks">,
  isUnread: boolean,
): SidebarThreadStatus {
  if (status !== "waiting" || !isUnread) return status;
  if (thread.latestRun?.status !== "completed") return status;
  return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks) ? status : "ready";
}
