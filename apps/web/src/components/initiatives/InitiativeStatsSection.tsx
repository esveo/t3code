/**
 * Fork: what the initiative's sessions took, each beside the range similar
 * finished sessions took, and each quota window with the initiative's
 * estimated share of it. Everything here shows; nothing brakes on it yet.
 */
import type {
  EnvironmentId,
  Initiative,
  InitiativeQuotaShare,
  InitiativeStatsEstimate,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { formatDuration, formatRange, formatTokens, formatUsd } from "./initiativeStats.logic";
import { initiativesEnvironment } from "./initiativesState";

const OUTCOME_LABELS = {
  done: "fertig",
  rework: "nachgearbeitet",
  cancelled: "abgebrochen",
} as const;

const Actual = ({
  value,
  range,
  format,
}: {
  readonly value: number | null;
  readonly range: readonly [number, number] | null | undefined;
  readonly format: (value: number) => string;
}) => (
  <td>
    {value === null ? "–" : format(value)}
    {range ? (
      <span className="block text-[11px] text-muted-foreground">
        üblich {formatRange(range, format)}
      </span>
    ) : null}
  </td>
);

export function InitiativeStatsSection({
  environmentId,
  initiative,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const report = useEnvironmentQuery(
    initiativesEnvironment.statsReport({ environmentId, input: { initiativeId: initiative.id } }),
  );
  const [busy, setBusy] = useState(false);
  const measure = async () => {
    setBusy(true);
    await act({ environmentId, input: { type: "statsRefresh", initiativeId: initiative.id } });
    setBusy(false);
    report.refresh();
  };
  const sessions = report.data?.sessions ?? [];

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Verbrauch</h2>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void measure()}>
          Neu messen
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Kosten sind API-Preise der verbrauchten Tokens, keine Rechnung. „Üblich“ ist die mittlere
        Spanne abgeschlossener Sessions mit demselben Modell oder Provider.
      </p>
      {sessions.length > 0 ? (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Session</th>
              <th className="font-medium">API-Kosten</th>
              <th className="font-medium">Tokens</th>
              <th className="font-medium">Dauer</th>
              <th className="font-medium">Turns</th>
              <th className="font-medium">Ergebnis</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {sessions.map(({ sessionId, title, stats, estimate }) => (
              <tr key={sessionId} className="border-t border-border align-top">
                <td className="py-1">
                  {title}
                  <span className="block text-[11px] text-muted-foreground">
                    {stats.provider}
                    {stats.model ? ` · ${stats.model}` : ""}
                  </span>
                </td>
                <Actual value={stats.apiUsd} range={estimate?.apiUsd} format={formatUsd} />
                <Actual
                  value={
                    stats.tokens
                      ? stats.tokens.input +
                        stats.tokens.output +
                        stats.tokens.cacheRead +
                        stats.tokens.cacheWrite
                      : null
                  }
                  range={estimate?.tokens}
                  format={formatTokens}
                />
                <Actual
                  value={stats.durationMs}
                  range={estimate?.durationMs}
                  format={formatDuration}
                />
                <Actual value={stats.turns} range={estimate?.turns} format={String} />
                <td>{stats.outcome ? OUTCOME_LABELS[stats.outcome] : "läuft"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">
          {report.data ? "Noch nicht gemessen." : "Lädt …"}
        </p>
      )}
      <QuotaList quota={report.data?.quota ?? []} />
    </section>
  );
}

/** Each window's use, split into this initiative, the others and what no session explains. */
export function QuotaList({ quota }: { readonly quota: ReadonlyArray<InitiativeQuotaShare> }) {
  if (quota.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {quota.map((window) => (
        <li key={`${window.accountId}|${window.windowId}`} className="flex flex-wrap gap-x-2">
          <span className="font-medium">
            {window.accountId} · {window.windowLabel}: {Math.round(window.usedPercent)} % belegt
          </span>
          {window.quality === "unavailable" ? (
            <span className="text-muted-foreground">(nicht abrufbar)</span>
          ) : (
            <span className="text-muted-foreground">
              davon geschätzt dieses Vorhaben {window.initiativePercent} %, andere Vorhaben{" "}
              {window.otherInitiativesPercent} %, nicht zuordenbar {window.unattributedPercent} %
            </span>
          )}
          <Badge variant="outline">
            Schätzung{window.confidence === "low" ? ", unsicher" : ""}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** One line with what a thread on this provider usually takes. */
export function EstimateLine({ estimate }: { readonly estimate: InitiativeStatsEstimate }) {
  const parts = [
    formatRange(estimate.apiUsd, formatUsd),
    formatRange(estimate.tokens, formatTokens),
    formatRange(estimate.durationMs, formatDuration),
  ].filter(Boolean);
  return (
    <span className="text-xs text-muted-foreground">
      Üblich: {parts.join(" · ")} (Schätzung aus {estimate.basis} Sessions
      {estimate.match === "same-model" ? " mit diesem Modell" : " dieses Providers"})
    </span>
  );
}
