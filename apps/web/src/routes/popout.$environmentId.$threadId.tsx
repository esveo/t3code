import { createFileRoute, redirect } from "@tanstack/react-router";

import { ThreadPopoutView } from "../components/popout/ThreadPopoutView";
import { resolveThreadRouteRef } from "../threadRoutes";

function PopoutRoute() {
  const threadRef = Route.useParams({ select: resolveThreadRouteRef });
  if (!threadRef) return null;
  return <ThreadPopoutView threadRef={threadRef} />;
}

export const Route = createFileRoute("/popout/$environmentId/$threadId")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PopoutRoute,
});
