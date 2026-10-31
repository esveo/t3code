/**
 * Fork: the "Voice" card under the Codex limits. Each server counts its own calls,
 * so the card sums them. Refetched when the page opens.
 */
import { ProviderDriverKind, type VoiceCallUsage } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useEnvironmentQuery } from "~/state/query";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { formatDuration } from "../agentTime/agentTimeChart";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { barColor } from "../usage/UsageLimits";
import { voiceCallEnvironment } from "./voiceCallState";

const CODEX = ProviderDriverKind.make("codex");

type EnvironmentVoiceUsage = {
  readonly label: string;
  readonly environmentId: string;
  readonly usage: VoiceCallUsage;
};

export function VoiceCallUsageSection({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  return (
    <CollectVoiceUsage
      pending={environments.filter((environment) => environment.canReadDiagnostics)}
      collected={[]}
    />
  );
}

/** One component per environment, since a hook cannot run in a loop over a changing list. */
function CollectVoiceUsage({
  pending,
  collected,
}: {
  readonly pending: readonly EnvironmentUsageStatus[];
  readonly collected: readonly EnvironmentVoiceUsage[];
}) {
  const [environment, ...rest] = pending;
  const usage = useEnvironmentQuery(
    environment
      ? voiceCallEnvironment.usage({ environmentId: environment.environmentId, input: {} })
      : null,
  ).data;
  if (!environment) return <VoiceCallUsageCard entries={collected} />;
  return (
    <CollectVoiceUsage
      pending={rest}
      collected={
        usage?.offered
          ? [
              ...collected,
              { label: environment.label, environmentId: environment.environmentId, usage },
            ]
          : collected
      }
    />
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function VoiceCallUsageCard({ entries }: { readonly entries: readonly EnvironmentVoiceUsage[] }) {
  if (entries.length === 0) return null;
  const used = entries.reduce((sum, entry) => sum + entry.usage.last24HoursSeconds, 0);
  const last30Days = entries.reduce((sum, entry) => sum + entry.usage.last30DaysSeconds, 0);
  // ponytail: assumes one ChatGPT account behind all servers, so their limits are one limit, not a sum.
  const limit = entries.reduce<number | null>(
    (max, entry) =>
      entry.usage.limitSeconds === null ? max : Math.max(max ?? 0, entry.usage.limitSeconds),
    null,
  );
  const plan = entries.find((entry) => entry.usage.planLabel !== null)?.usage.planLabel ?? null;
  const remaining =
    limit === null ? null : Math.max(0, Math.round(100 - Math.min(100, (used / limit) * 100)));

  // The look of UsageLimitsPooled's PoolWindowCard, whose bar needs a provider account.
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">Voice</span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {remaining === null ? formatDuration(used) : `${remaining}%`}
          </span>
          <span className="text-sm text-muted-foreground">
            {remaining === null ? "used" : "left"}
          </span>
        </span>
      </div>
      <div className="@container/pool min-w-0">
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <button
                type="button"
                aria-label={`Voice: ${remaining === null ? `${formatDuration(used)} used` : `${remaining}% left`}, rolling 24 hours`}
                className="relative block h-5 w-full min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border @2xl/pool:h-8"
              />
            }
          >
            <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
              <div
                className="absolute inset-y-0 left-0 rounded-md opacity-35"
                style={{ width: `${remaining ?? 0}%`, backgroundColor: barColor(CODEX) }}
              />
            </div>
            <div className="relative hidden h-full min-w-0 items-center overflow-hidden rounded-md px-2 text-xs @2xl/pool:flex">
              <span className="ms-auto rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs whitespace-nowrap text-foreground tabular-nums">
                rolling 24h
              </span>
            </div>
          </PopoverTrigger>
          <PopoverPopup side="top" sideOffset={6}>
            <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
              <span className="text-sm font-medium text-foreground">Voice</span>
              <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
                {plan === null ? null : <Row label="Plan">{plan}</Row>}
                <Row label="Used">{formatDuration(used)} in 24h</Row>
                {limit === null ? null : (
                  <Row label="Left">{formatDuration(Math.max(0, limit - used))} in 24h</Row>
                )}
                <Row label="30 days">{formatDuration(last30Days)}</Row>
              </div>
              {entries.length > 1 ? (
                <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
                  {entries.map((entry) => (
                    <Row key={entry.environmentId} label={entry.label}>
                      {formatDuration(entry.usage.last24HoursSeconds)} in 24h
                    </Row>
                  ))}
                </div>
              ) : null}
              <p className="border-t border-border/60 pt-2.5 text-muted-foreground">
                An estimate from esveo code&apos;s own count, not OpenAI&apos;s figure.
              </p>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </div>
  );
}
