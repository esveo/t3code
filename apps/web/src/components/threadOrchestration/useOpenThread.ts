import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { revealThreadInSplit } from "~/components/split/splitPanes";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";

/** Opens a thread the way the sidebar does: in its split pane when one shows it. */
export function useOpenThread() {
  const router = useRouter();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  return useCallback(
    (threadRef: ScopedThreadRef) => {
      if (revealThreadInSplit(threadRef, routeThreadRef)) return;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [routeThreadRef, router],
  );
}
