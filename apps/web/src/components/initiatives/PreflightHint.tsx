/**
 * Fork: the preflight's verdict beside a waiting approval, for threads of an
 * initiative. In shadow mode it only says what it would have answered; the
 * user's click decides and is what the preflight is measured against.
 */
import type { EnvironmentId, PreflightWouldHave, ThreadId } from "@t3tools/contracts";

import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { initiativesEnvironment } from "./initiativesState";

export const WOULD_HAVE_LABELS: Record<PreflightWouldHave, string> = {
  accept: "würde freigeben",
  decline: "würde ablehnen",
  ask: "würde fragen",
};

export function PreflightHint({
  environmentId,
  threadId,
  requestId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: string;
}) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.initiatives === true;
  const preflight = useEnvironmentQuery(
    supported
      ? initiativesEnvironment.threadPreflight({ environmentId, input: { threadId } })
      : null,
  );
  const verdict = preflight.data?.observations.find(
    (observation) => observation.requestId === requestId,
  )?.verdicts[0];
  if (!verdict) return null;
  return (
    <span className="text-[11px] text-muted-foreground">
      Vorprüfung (nur Schatten): {WOULD_HAVE_LABELS[verdict.wouldHave]} · {verdict.reason}
    </span>
  );
}
