/**
 * Fork: one initiative: its brief, projects, the threads that work on it
 * and a form to start another one. Every change goes through the server's
 * `act`, which writes an audit row; the page only shows the result.
 */
import {
  type EnvironmentId,
  type Initiative,
  type InitiativeDetailSnapshot,
  isProviderAvailable,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { SESSION_STATE_LABELS, type InitiativeSessionState } from "@t3tools/initiatives/model";
import { Link } from "@tanstack/react-router";
import { ArchiveIcon, ArchiveRestoreIcon, OctagonPauseIcon, PlayIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useNowMinute } from "~/hooks/useNowMinute";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  countStates,
  formatUsd,
  sessionRows,
  suggestedThreads,
  totalCost,
  type SessionRow,
} from "./initiatives.logic";
import { InitiativeBrainSection } from "./InitiativeBrainSection";
import { InitiativeCoordinatorSection } from "./InitiativeCoordinatorSection";
import { InitiativeEntriesSection } from "./InitiativeEntriesSection";
import { InitiativeImportSection, SOURCE_LABELS } from "./InitiativeImportSection";
import { InitiativePreflightSection } from "./InitiativePreflightSection";
import { EstimateLine, InitiativeStatsSection, QuotaList } from "./InitiativeStatsSection";
import { initiativesEnvironment } from "./initiativesState";
import { INITIATIVE_STATUS_LABELS } from "./InitiativesPage";

const STATE_BADGE: Record<
  InitiativeSessionState,
  "info" | "warning" | "error" | "success" | "secondary"
> = {
  running: "info",
  waiting: "warning",
  stalled: "warning",
  review: "info",
  done: "success",
  stopped: "secondary",
  failed: "error",
  unknown: "secondary",
};

function useAct(environmentId: EnvironmentId) {
  const act = useAtomCommand(initiativesEnvironment.act);
  return (input: Parameters<typeof act>[0]["input"]) => act({ environmentId, input });
}

export function InitiativeDetail({
  environmentId,
  initiativeId,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiativeId: string;
}) {
  const detail = useEnvironmentQuery(
    initiativesEnvironment.detail({ environmentId, input: { initiativeId } }),
  );
  if (detail.error) return <p className="text-sm text-destructive">{detail.error}</p>;
  if (!detail.data) return <p className="text-sm text-muted-foreground">Lade Vorhaben …</p>;
  if (!detail.data.initiative) {
    return <p className="text-sm text-muted-foreground">Dieses Vorhaben gibt es nicht.</p>;
  }
  return (
    <LoadedInitiative
      environmentId={environmentId}
      initiative={detail.data.initiative}
      detail={detail.data}
    />
  );
}

function LoadedInitiative({
  environmentId,
  initiative,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly detail: InitiativeDetailSnapshot;
}) {
  const act = useAct(environmentId);
  const shells = useThreadShells();
  const list = useEnvironmentQuery(initiativesEnvironment.list({ environmentId, input: {} }));
  const homeEnvironmentId = initiative.homeEnvironmentId ?? environmentId;
  // A minute's resolution is enough to call a thread stalled after 30 minutes.
  const nowMs = Date.parse(useNowMinute());
  const rows = useMemo(
    () => sessionRows({ sessions: detail.sessions, shells, homeEnvironmentId, nowMs }),
    [detail.sessions, shells, homeEnvironmentId, nowMs],
  );
  const suggestions = useMemo(
    () =>
      suggestedThreads({
        projects: detail.projects,
        sessions: detail.sessions,
        assignedElsewhere: (list.data?.initiatives ?? []).filter(
          (entry) => entry.initiative.id !== initiative.id,
        ),
        shells,
        homeEnvironmentId,
      }),
    [detail.projects, detail.sessions, list.data, initiative.id, shells, homeEnvironmentId],
  );
  const released = detail.sessions.filter((session) => session.assignment === "released");
  const counts = countStates(rows);
  const failedStarts = detail.launchJobs.filter((job) => job.status === "failed");
  const archived = initiative.status === "archived";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">{initiative.title}</h1>
        {initiative.status !== "active" ? (
          <Badge variant="secondary">{INITIATIVE_STATUS_LABELS[initiative.status]}</Badge>
        ) : null}
        {(Object.keys(counts) as Array<InitiativeSessionState>).map((state) => (
          <Badge key={state} variant={STATE_BADGE[state]}>
            {counts[state]} {SESSION_STATE_LABELS[state]}
          </Badge>
        ))}
        <UsageBadge environmentId={environmentId} initiativeId={initiative.id} />
        {initiative.halted ? <Badge variant="error">angehalten</Badge> : null}
        <Button
          size="sm"
          variant={initiative.halted ? "outline" : "destructive-outline"}
          onClick={() =>
            void act({
              type: "setHalt",
              initiativeId: initiative.id,
              halted: !initiative.halted,
            })
          }
        >
          {initiative.halted ? <PlayIcon /> : <OctagonPauseIcon />}
          {initiative.halted ? "Fortsetzen" : "Anhalten"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void act({ type: archived ? "reopen" : "archive", initiativeId: initiative.id })
          }
        >
          {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {archived ? "Wieder öffnen" : "Archivieren"}
        </Button>
      </header>

      <BriefEditor environmentId={environmentId} initiative={initiative} />
      <InitiativeCoordinatorSection
        environmentId={environmentId}
        initiative={initiative}
        handoffCommit={
          detail.brainPages.find((page) => page.layer === "handoff")?.lastCommit ?? null
        }
      />
      <ProjectsSection environmentId={environmentId} initiative={initiative} detail={detail} />
      {!archived ? (
        <StartThreadForm environmentId={environmentId} initiative={initiative} detail={detail} />
      ) : null}

      {failedStarts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Fehlgeschlagene Starts</h2>
          {failedStarts.map((job) => (
            <div
              key={job.id}
              className="flex items-start gap-2 rounded-lg border border-destructive/40 p-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{job.spec.title}</p>
                <p className="text-xs text-muted-foreground">{job.error}</p>
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void act({
                    type: "dismissLaunch",
                    initiativeId: initiative.id,
                    launchJobId: job.id,
                  })
                }
              >
                Ausblenden
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Sessions</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Noch keine Threads. Starte einen oben oder ordne einen der Vorschläge zu.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {rows.map((row) => (
              <SessionListItem
                key={row.session.id}
                row={row}
                homeEnvironmentId={homeEnvironmentId}
                onUnassign={(threadId) =>
                  void act({ type: "unassignThread", initiativeId: initiative.id, threadId })
                }
              />
            ))}
          </ul>
        )}
      </section>

      <InitiativeImportSection
        environmentId={environmentId}
        initiative={initiative}
        detail={detail}
      />

      {suggestions.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Vorschläge aus den Projekten</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-dashed border-border">
            {suggestions.slice(0, 20).map((shell) => (
              <li
                key={`${shell.environmentId}:${shell.id}`}
                className="flex items-center gap-2 p-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{shell.title}</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void act({
                      type: "assignThread",
                      initiativeId: initiative.id,
                      threadId: shell.id,
                      ...(shell.environmentId !== homeEnvironmentId
                        ? { environmentId: shell.environmentId, title: shell.title }
                        : {}),
                    })
                  }
                >
                  Zuordnen
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <InitiativeEntriesSection
        environmentId={environmentId}
        initiative={initiative}
        entries={detail.entries}
        links={detail.links}
      />

      <InitiativeStatsSection environmentId={environmentId} initiative={initiative} />

      <InitiativePreflightSection environmentId={environmentId} initiative={initiative} />

      <InitiativeBrainSection
        environmentId={environmentId}
        initiative={initiative}
        pages={detail.brainPages}
        brainError={detail.brainError}
      />

      {released.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Aus dem Vorhaben genommen</h2>
          <ul className="flex flex-col gap-1">
            {released.map((session) => (
              <li
                key={session.id}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                {session.threadId ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void act({
                        type: "assignThread",
                        initiativeId: initiative.id,
                        threadId: session.threadId as ThreadId,
                        ...(session.environmentId && session.environmentId !== homeEnvironmentId
                          ? { environmentId: session.environmentId }
                          : {}),
                      })
                    }
                  >
                    Wieder zuordnen
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function UsageBadge({
  environmentId,
  initiativeId,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiativeId: string;
}) {
  const usage = useEnvironmentQuery(
    initiativesEnvironment.usage({ environmentId, input: { initiativeId } }),
  );
  if (!usage.data || usage.data.threads.length === 0) return null;
  const total = totalCost(usage.data.threads);
  return (
    <Badge
      variant="outline"
      title={`API-äquivalente Kosten, keine Rechnung${total.unknown > 0 ? `; ${total.unknown} Threads ohne Daten` : ""}`}
    >
      ≈ {formatUsd(total.costUsd)} API
    </Badge>
  );
}

function SessionListItem({
  row,
  homeEnvironmentId,
  onUnassign,
}: {
  readonly row: SessionRow;
  readonly homeEnvironmentId: EnvironmentId;
  readonly onUnassign: (threadId: ThreadId) => void;
}) {
  const threadId = row.session.threadId;
  const environmentId = row.session.environmentId ?? homeEnvironmentId;
  const imported = row.session.source !== "t3";
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 p-2 text-sm">
      {imported ? (
        <Badge variant="outline">{SOURCE_LABELS[row.session.source]}</Badge>
      ) : (
        <Badge variant={STATE_BADGE[row.state]}>{SESSION_STATE_LABELS[row.state]}</Badge>
      )}
      {threadId && row.shell ? (
        <Link
          className="min-w-0 flex-1 truncate hover:underline"
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId }}
        >
          {row.title}
        </Link>
      ) : (
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
      )}
      {row.session.assignment === "auto" ? (
        <span className="text-xs text-muted-foreground">gestartet vom Vorhaben</span>
      ) : null}
      {(row.shell?.branch ?? row.session.branch) ? (
        <span className="max-w-48 truncate font-mono text-xs text-muted-foreground">
          {row.shell?.branch ?? row.session.branch}
        </span>
      ) : null}
      {threadId ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Aus dem Vorhaben nehmen"
          title="Aus dem Vorhaben nehmen"
          onClick={() => onUnassign(threadId)}
        >
          <XIcon />
        </Button>
      ) : null}
      {imported && row.session.startedAt ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {new Date(row.session.startedAt).toLocaleDateString("de-DE")}
        </span>
      ) : null}
      {row.session.summary ? (
        <p className="w-full text-xs text-muted-foreground">{row.session.summary}</p>
      ) : null}
    </li>
  );
}

function BriefEditor({
  environmentId,
  initiative,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
}) {
  const act = useAct(environmentId);
  // A draft exists only while editing; otherwise the fields show the server's
  // current brief, so someone else's change shows up at once.
  const [draft, setDraft] = useState<{
    readonly title: string;
    readonly goal: string;
    readonly instructions: string;
    readonly revision: number;
  } | null>(null);
  const value = draft ?? {
    title: initiative.title,
    goal: initiative.goalText,
    instructions: initiative.instructionsMd,
    revision: initiative.revision,
  };
  const edit = (patch: Partial<typeof value>) => setDraft({ ...value, ...patch });

  const save = async () => {
    const result = await act({
      type: "update",
      initiativeId: initiative.id,
      // Refused when the brief changed since the draft began.
      expectedRevision: value.revision,
      title: value.title.trim() || initiative.title,
      goalText: value.goal,
      instructionsMd: value.instructions,
    });
    if (result._tag === "Success") setDraft(null);
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Steckbrief</h2>
      <Input
        value={value.title}
        onChange={(event) => edit({ title: event.target.value })}
        aria-label="Titel"
      />
      <Textarea
        value={value.goal}
        onChange={(event) => edit({ goal: event.target.value })}
        placeholder="Ziel"
        aria-label="Ziel"
      />
      <Textarea
        value={value.instructions}
        onChange={(event) => edit({ instructions: event.target.value })}
        placeholder="Anweisungen, die jeder Thread des Vorhabens beim Start bekommt (Markdown)"
        aria-label="Anweisungen"
      />
      {draft ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            Verwerfen
          </Button>
          <Button size="sm" onClick={() => void save()}>
            Speichern
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ProjectsSection({
  environmentId,
  initiative,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly detail: InitiativeDetailSnapshot;
}) {
  const act = useAct(environmentId);
  const projects = useProjects();
  const included = new Set(detail.projects.map((project) => project.projectId));
  const candidates = projects.filter(
    (project) => project.environmentId === environmentId && !included.has(project.id),
  );
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Projekte</h2>
      <div className="flex flex-wrap items-center gap-2">
        {detail.projects.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Noch keine. Arbeit ohne Code braucht keins.
          </span>
        ) : null}
        {detail.projects.map((project) => (
          <Badge key={project.id} variant="secondary" title={project.workspaceRoot}>
            {project.label}
            <button
              type="button"
              className="cursor-pointer"
              aria-label={`${project.label} entfernen`}
              onClick={() =>
                void act({
                  type: "removeProject",
                  initiativeId: initiative.id,
                  initiativeProjectId: project.id,
                })
              }
            >
              <XIcon />
            </button>
          </Badge>
        ))}
        {candidates.length > 0 ? (
          <Select
            value=""
            onValueChange={(value) => {
              if (typeof value === "string" && value) {
                void act({
                  type: "addProject",
                  initiativeId: initiative.id,
                  projectId: value as ProjectId,
                });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="Projekt hinzufügen">
              <SelectValue>Projekt hinzufügen …</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {candidates.map((project) => (
                <SelectItem key={project.id} hideIndicator value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </div>
    </section>
  );
}

/** What a thread on the chosen provider usually takes, and its quota now. */
function StartEstimate({
  environmentId,
  initiativeId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiativeId: string;
  readonly provider: string;
}) {
  const result = useEnvironmentQuery(
    initiativesEnvironment.statsEstimate({
      environmentId,
      input: { initiativeId, provider, model: null },
    }),
  );
  if (!result.data) return null;
  return (
    <div className="flex flex-col gap-1">
      {result.data.estimate ? (
        <EstimateLine estimate={result.data.estimate} />
      ) : (
        <span className="text-xs text-muted-foreground">
          Noch zu wenige abgeschlossene Sessions für eine Schätzung.
        </span>
      )}
      <QuotaList quota={result.data.quota} />
    </div>
  );
}

function StartThreadForm({
  environmentId,
  initiative,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly detail: InitiativeDetailSnapshot;
}) {
  const act = useAct(environmentId);
  const serverConfig = useServerConfigs().get(environmentId);
  const projects = detail.projects.filter((project) => project.projectId !== null);
  const providers = (serverConfig?.providers ?? []).filter(
    (provider) =>
      provider.enabled &&
      isProviderAvailable(provider) &&
      !initiative.providerExclusions.includes(provider.instanceId),
  );
  const [projectId, setProjectId] = useState<string>("");
  const [provider, setProvider] = useState<string>("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  // One key per submit: a retried request starts nothing twice.
  const [key, setKey] = useState(() => randomUUID());
  const [busy, setBusy] = useState(false);
  const chosenProject = projectId || projects[0]?.projectId || "";

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Füge ein Projekt hinzu, um Threads aus dem Vorhaben zu starten.
      </p>
    );
  }

  const submit = async () => {
    if (!title.trim() || !prompt.trim() || !chosenProject || busy) return;
    setBusy(true);
    const result = await act({
      type: "startThread",
      initiativeId: initiative.id,
      key,
      projectId: chosenProject as ProjectId,
      title: title.trim(),
      prompt: prompt.trim(),
      ...(provider ? { provider } : {}),
    });
    setBusy(false);
    if (result._tag === "Success") {
      setTitle("");
      setPrompt("");
      setKey(randomUUID());
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Thread starten</h2>
      <form
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Select
            value={chosenProject}
            onValueChange={(value) => setProjectId(String(value ?? ""))}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="Projekt">
              <SelectValue>
                {projects.find((project) => project.projectId === chosenProject)?.label ??
                  "Projekt"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {projects.map((project) => (
                <SelectItem key={project.id} hideIndicator value={project.projectId!}>
                  {project.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select value={provider} onValueChange={(value) => setProvider(String(value ?? ""))}>
            <SelectTrigger size="sm" className="w-48" aria-label="Provider">
              <SelectValue>
                {providers.find((candidate) => candidate.instanceId === provider)?.displayName ??
                  (provider || "Provider: Standard")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="">
                Standard des Projekts
              </SelectItem>
              {providers.map((candidate) => (
                <SelectItem key={candidate.instanceId} hideIndicator value={candidate.instanceId}>
                  {candidate.displayName ?? candidate.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Input
            className="min-w-48 flex-1"
            placeholder="Titel des Threads"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        {provider ? (
          <StartEstimate
            environmentId={environmentId}
            initiativeId={initiative.id}
            provider={provider}
          />
        ) : null}
        <Textarea
          placeholder="Auftrag: Was soll der Thread tun, woran erkennt er, dass er fertig ist?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">
            Eigener Worktree, Modus „Auto“, mit dem Steckbrief vorneweg.
          </span>
          <Button type="submit" size="sm" disabled={!title.trim() || !prompt.trim() || busy}>
            <PlayIcon />
            Starten
          </Button>
        </div>
      </form>
    </section>
  );
}
