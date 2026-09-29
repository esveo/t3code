/**
 * Fork: the preflight's record of an initiative. Per provider: how many
 * approval requests came, how many landed on the user despite auto mode, and
 * how often the shadow verdict matched the user's click; below, the latest
 * requests with a filter for the disagreements and a way to mark a verdict
 * as wrong.
 */
import type { EnvironmentId, Initiative, InitiativeApprovalObservation } from "@t3tools/contracts";
import { answerOf, PROVIDER_COVERAGE } from "@t3tools/initiatives/preflight";
import { useMemo, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { initiativesEnvironment } from "./initiativesState";
import { WOULD_HAVE_LABELS } from "./PreflightHint";

type Filter = "all" | "disagree" | "wrong";

const disagrees = (observation: InitiativeApprovalObservation) => {
  const answer = answerOf(observation.decision);
  const verdict = observation.verdicts[0]?.wouldHave;
  return (
    observation.resolvedBy === "person" &&
    answer !== null &&
    verdict !== undefined &&
    verdict !== answer
  );
};

const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${Math.round((part / whole) * 100)} %`;

export function InitiativePreflightSection({
  environmentId,
  initiative,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const report = useEnvironmentQuery(
    initiativesEnvironment.preflightReport({
      environmentId,
      input: { initiativeId: initiative.id },
    }),
  );
  const [filter, setFilter] = useState<Filter>("disagree");
  const observations = useMemo(
    () =>
      (report.data?.observations ?? []).filter((observation) =>
        filter === "all"
          ? true
          : filter === "wrong"
            ? observation.markedWrongBy !== null
            : disagrees(observation),
      ),
    [report.data, filter],
  );
  const shadow = initiative.preflightMode === "shadow";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Freigaben und Vorprüfung</h2>
        <Button size="xs" variant="ghost" onClick={report.refresh}>
          Aktualisieren
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void act({
              environmentId,
              input: {
                type: "setPreflightMode",
                initiativeId: initiative.id,
                mode: shadow ? "off" : "shadow",
              },
            })
          }
        >
          {shadow ? "Vorprüfung aus" : "Vorprüfung im Schatten an"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Threads des Vorhabens laufen im Modus „Auto“. Die Vorprüfung schreibt nur mit, was sie bei
        jeder Anfrage, die trotzdem bei dir landet, geantwortet hätte; entscheiden tust du.
      </p>
      {report.data && report.data.providers.length > 0 ? (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Provider</th>
              <th className="font-medium">Anfragen</th>
              <th className="font-medium">bei dir (Auto)</th>
              <th className="font-medium">pro Stunde</th>
              <th className="font-medium">Übereinstimmung</th>
              <th className="font-medium">falsch freigegeben</th>
              <th className="font-medium">unnötig gefragt</th>
              <th className="font-medium">zurückgedreht</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {report.data.providers.map((stats) => (
              <tr key={stats.provider} className="border-t border-border">
                <td className="py-1">
                  {stats.provider}
                  <span className="block text-[11px] text-muted-foreground">
                    {PROVIDER_COVERAGE[stats.provider]?.note ?? "Abdeckung unbekannt"}
                  </span>
                </td>
                <td>{stats.requests}</td>
                <td>
                  {stats.byPerson} ({stats.inAutoMode})
                </td>
                <td>{stats.perHour ?? "–"}</td>
                <td>{percent(stats.agreed, stats.byPerson)}</td>
                <td>{stats.wrongAccepts}</td>
                <td>{stats.needlessAsks}</td>
                <td>
                  {percent(stats.rolledBack, stats.rollbackBase)} ({stats.rolledBack}/
                  {stats.rollbackBase})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">Noch keine Freigabe-Anfragen gesehen.</p>
      )}
      {report.data && report.data.threads.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Zurückgedreht je Thread:{" "}
          {report.data.threads
            .map(
              (thread) =>
                `${thread.title ?? thread.threadId} (${thread.provider ?? "?"}) ${thread.rolledBack}/${thread.base}`,
            )
            .join(" · ")}
        </p>
      ) : null}
      {report.data && report.data.observations.length > 0 ? (
        <>
          <ToggleGroup
            value={[filter]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "all" || next === "disagree" || next === "wrong") setFilter(next);
            }}
          >
            <Toggle value="disagree" size="sm">
              Uneinig
            </Toggle>
            <Toggle value="wrong" size="sm">
              Als falsch markiert
            </Toggle>
            <Toggle value="all" size="sm">
              Alle
            </Toggle>
          </ToggleGroup>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {observations.slice(0, 50).map((observation) => (
              <ObservationRow
                key={observation.id}
                observation={observation}
                onMarkWrong={(wrong) =>
                  void act({
                    environmentId,
                    input: { type: "preflightMarkWrong", observationId: observation.id, wrong },
                  }).then(() => report.refresh())
                }
                onMarkRolledBack={(rolledBack) =>
                  void act({
                    environmentId,
                    input: {
                      type: "markRolledBack",
                      target: "observation",
                      id: observation.id,
                      rolledBack,
                    },
                  }).then(() => report.refresh())
                }
              />
            ))}
            {observations.length === 0 ? (
              <li className="p-2 text-sm text-muted-foreground">Keine.</li>
            ) : null}
          </ul>
        </>
      ) : null}
    </section>
  );
}

const EVIDENCE_LABELS = {
  hard: "Harte Ergebnisse",
  run: "Verlauf dieses Laufs",
  rollbacks: "Zurückgedreht",
  model: "Selbsteinschätzung des Modells",
} as const;

const RESOLVED_LABELS = {
  person: "von dir",
  "provider-auto": "vom Provider",
  expired: "abgelaufen",
} as const;

function ObservationRow({
  observation,
  onMarkWrong,
  onMarkRolledBack,
}: {
  readonly observation: InitiativeApprovalObservation;
  readonly onMarkWrong: (wrong: boolean) => void;
  readonly onMarkRolledBack: (rolledBack: boolean) => void;
}) {
  const verdict = observation.verdicts[0];
  const what =
    observation.action.command ??
    observation.action.tool ??
    observation.action.paths[0] ??
    observation.action.detail ??
    observation.requestType;
  return (
    <li className="flex flex-col gap-1 p-2 text-xs">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate">{what}</code>
        {verdict ? (
          <Badge
            variant={
              verdict.wouldHave === "accept"
                ? "success"
                : verdict.wouldHave === "decline"
                  ? "error"
                  : "warning"
            }
          >
            {WOULD_HAVE_LABELS[verdict.wouldHave]}
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          {observation.resolvedBy
            ? `${RESOLVED_LABELS[observation.resolvedBy]}: ${observation.decision ?? "–"}`
            : "offen"}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onMarkWrong(observation.markedWrongBy === null)}
        >
          {observation.markedWrongBy === null ? "Als falsch markieren" : "Markierung lösen"}
        </Button>
        {answerOf(observation.decision) === "accept" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onMarkRolledBack(!observation.rolledBackBy)}
          >
            {observation.rolledBackBy ? "Nicht zurückgedreht" : "Zurückgedreht"}
          </Button>
        ) : null}
      </div>
      {verdict ? (
        <span className="text-muted-foreground">
          {observation.provider} · {verdict.category} · {verdict.reason}
        </span>
      ) : null}
      {verdict?.evidence && verdict.evidence.length > 0 ? (
        <ol className="list-decimal pl-5 text-muted-foreground">
          {verdict.evidence.map((item) => (
            <li key={item.kind}>
              {EVIDENCE_LABELS[item.kind]}: {item.text}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
