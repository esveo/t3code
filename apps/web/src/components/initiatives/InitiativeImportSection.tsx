/**
 * Fork: "Frühere Arbeit übernehmen?". The catalog of earlier sessions per
 * source and folder (the initiative's own preselected), a metadata import of
 * the chosen ones, summaries on request within a cost cap, and the way back:
 * pause, resume or cancel a job, take imported sessions out again, turn the
 * automatic assignment of a folder off.
 */
import type {
  EnvironmentId,
  Initiative,
  InitiativeDetailSnapshot,
  InitiativeImportGroup,
  InitiativeImportSource,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { initiativesEnvironment } from "./initiativesState";

export const SOURCE_LABELS: Record<InitiativeImportSource, string> = {
  t3: "T3",
  "claude-code-cli": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
};

const JOB_STATUS_LABELS = {
  running: "läuft",
  paused: "pausiert",
  cancelled: "abgebrochen",
  done: "fertig",
  failed: "fehlgeschlagen",
} as const;

const groupKey = (group: Pick<InitiativeImportGroup, "source" | "cwd">) =>
  `${group.source}|${group.cwd}`;

const formatDate = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
      })
    : "–";

export function InitiativeImportSection({
  environmentId,
  initiative,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly detail: InitiativeDetailSnapshot;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const nothingYet = detail.sessions.length === 0 && detail.importJobs.length === 0;
  const [open, setOpen] = useState(false);
  const catalog = useEnvironmentQuery(
    open
      ? initiativesEnvironment.importCatalog({
          environmentId,
          input: { initiativeId: initiative.id },
        })
      : null,
  );
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [autoAssign, setAutoAssign] = useState(true);
  const [costCap, setCostCap] = useState("1");
  const groups = catalog.data?.groups ?? [];
  const selection =
    chosen ?? new Set(groups.filter((group) => group.preselected).map((group) => groupKey(group)));
  const selectedCount = groups
    .filter((group) => selection.has(groupKey(group)))
    .reduce((sum, group) => sum + group.count - group.imported - group.elsewhere, 0);

  const imported = useMemo(() => {
    const byFolder = new Map<
      string,
      { source: InitiativeImportSource; cwd: string; count: number }
    >();
    for (const session of detail.sessions) {
      if (session.source === "t3" || session.assignment === "released") continue;
      const key = `${session.source}|${session.cwd ?? ""}`;
      const entry = byFolder.get(key) ?? {
        source: session.source,
        cwd: session.cwd ?? "",
        count: 0,
      };
      entry.count += 1;
      byFolder.set(key, entry);
    }
    return [...byFolder.values()];
  }, [detail.sessions]);
  const withoutSummary = detail.sessions.filter(
    (session) =>
      session.source !== "t3" && session.assignment !== "released" && session.summary === null,
  );

  const toggle = (group: InitiativeImportGroup, checked: boolean) => {
    const next = new Set(selection);
    if (checked) next.add(groupKey(group));
    else next.delete(groupKey(group));
    setChosen(next);
  };

  const runImport = async () => {
    const picked = groups
      .filter((group) => selection.has(groupKey(group)))
      .map((group) => ({ source: group.source, cwd: group.cwd }));
    const [first, ...rest] = picked;
    if (!first) return;
    await act({
      environmentId,
      input: {
        type: "importRun",
        initiativeId: initiative.id,
        selection: [first, ...rest],
        autoAssign,
      },
    });
    catalog.refresh();
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">
          {nothingYet ? "Frühere Arbeit übernehmen?" : "Import früherer Arbeit"}
        </h2>
        <Button
          size="xs"
          variant={nothingYet ? "outline" : "ghost"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Schließen" : "Sessions suchen"}
        </Button>
      </div>
      {nothingYet && !open ? (
        <p className="text-xs text-muted-foreground">
          Sessions aus T3, Claude Code (Terminal und Desktop) und Codex, die in den Ordnern dieses
          Vorhabens liefen, lassen sich übernehmen. Erst nur Metadaten; Zusammenfassungen auf Abruf.
        </p>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          {catalog.error ? <p className="text-xs text-destructive">{catalog.error}</p> : null}
          {!catalog.data ? (
            <p className="text-sm text-muted-foreground">Durchsuche frühere Sessions …</p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine früheren Sessions gefunden.</p>
          ) : (
            <>
              <ul className="flex max-h-80 flex-col overflow-auto">
                {groups.map((group) => {
                  const open = group.count - group.imported - group.elsewhere;
                  return (
                    <li key={groupKey(group)} className="flex items-center gap-2 py-1 text-xs">
                      <Checkbox
                        checked={selection.has(groupKey(group))}
                        disabled={open === 0}
                        onCheckedChange={(checked) => toggle(group, checked === true)}
                        aria-label={`${SOURCE_LABELS[group.source]} ${group.cwd}`}
                      />
                      <Badge variant="outline">{SOURCE_LABELS[group.source]}</Badge>
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {group.cwd || "(ohne Ordner)"}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {group.count} · {formatDate(group.firstAt)}–{formatDate(group.lastAt)}
                        {group.imported > 0 ? ` · ${group.imported} übernommen` : ""}
                        {group.elsewhere > 0 ? ` · ${group.elsewhere} anderswo` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={autoAssign}
                  onCheckedChange={(checked) => setAutoAssign(checked)}
                />
                Neue Sessions aus diesen Ordnern künftig automatisch zuordnen
              </label>
              <div className="flex justify-end">
                <Button size="sm" disabled={selectedCount === 0} onClick={() => void runImport()}>
                  {selectedCount === 1
                    ? "1 Session übernehmen"
                    : `${selectedCount} Sessions übernehmen`}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {detail.importJobs.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {detail.importJobs
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 5)
            .map((job) => (
              <li key={job.id} className="flex items-center gap-2">
                <Badge
                  variant={
                    job.status === "failed"
                      ? "error"
                      : job.status === "running"
                        ? "info"
                        : "secondary"
                  }
                >
                  {job.phase === "metadata" ? "Import" : "Zusammenfassungen"}:{" "}
                  {JOB_STATUS_LABELS[job.status]}
                </Badge>
                <span className="tabular-nums text-muted-foreground">
                  {job.done}/{job.total || "?"} · {job.added} neu · {job.skipped} übersprungen
                  {job.phase === "summary"
                    ? ` · $${job.spentUsd.toFixed(2)} von $${(job.costCapUsd ?? 0).toFixed(2)}`
                    : ""}
                </span>
                {job.error ? (
                  <span className="min-w-0 flex-1 truncate text-destructive">{job.error}</span>
                ) : (
                  <span className="flex-1" />
                )}
                {job.status === "running" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void act({
                        environmentId,
                        input: { type: "importPause", initiativeId: initiative.id, jobId: job.id },
                      })
                    }
                  >
                    Pausieren
                  </Button>
                ) : null}
                {job.status === "paused" || job.status === "failed" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void act({
                        environmentId,
                        input: { type: "importResume", initiativeId: initiative.id, jobId: job.id },
                      })
                    }
                  >
                    Fortsetzen
                  </Button>
                ) : null}
                {job.status === "running" || job.status === "paused" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void act({
                        environmentId,
                        input: { type: "importCancel", initiativeId: initiative.id, jobId: job.id },
                      })
                    }
                  >
                    Abbrechen
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
      ) : null}

      {withoutSummary.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {withoutSummary.length} übernommene Sessions ohne Zusammenfassung. Kosten höchstens $
          </span>
          <Input
            className="w-20"
            inputMode="decimal"
            value={costCap}
            onChange={(event) => setCostCap(event.target.value)}
            aria-label="Kostenobergrenze in Dollar"
          />
          <Button
            size="xs"
            variant="outline"
            disabled={!(Number(costCap.replace(",", ".")) > 0)}
            onClick={() => {
              const [first, ...rest] = withoutSummary.slice(0, 200).map((session) => session.id);
              if (!first) return;
              void act({
                environmentId,
                input: {
                  type: "importSummarize",
                  initiativeId: initiative.id,
                  sessionIds: [first, ...rest],
                  costCapUsd: Number(costCap.replace(",", ".")),
                },
              });
            }}
          >
            Zusammenfassen
          </Button>
        </div>
      ) : null}

      {imported.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Übernommene Ordner ({imported.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {imported.map((entry) => {
              const rule = detail.autoAssignRules.find(
                (candidate) =>
                  candidate.source === entry.source && candidate.cwdPrefix === entry.cwd,
              );
              return (
                <li key={`${entry.source}|${entry.cwd}`} className="flex items-center gap-2">
                  <Badge variant="outline">{SOURCE_LABELS[entry.source]}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {entry.cwd || "(ohne Ordner)"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{entry.count}</span>
                  {rule ? (
                    <label className="flex items-center gap-1 text-muted-foreground">
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(checked) =>
                          void act({
                            environmentId,
                            input: {
                              type: "autoAssignRuleSet",
                              initiativeId: initiative.id,
                              ruleId: rule.id,
                              enabled: checked,
                            },
                          })
                        }
                      />
                      automatisch
                    </label>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void act({
                        environmentId,
                        input: {
                          type: "importRemove",
                          initiativeId: initiative.id,
                          source: entry.source,
                          cwd: entry.cwd,
                        },
                      })
                    }
                  >
                    Entfernen
                  </Button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
