/**
 * Fork: the Initiatives page ("Vorhaben"). The list of initiatives with a
 * form to create one, or, with an id in the URL, one initiative in detail.
 * It reads the environment that hosts the initiatives: the one named in the
 * URL, or the primary one.
 */
import { type EnvironmentId, type InitiativeSummary, ThreadId } from "@t3tools/contracts";
import { SESSION_STATE_LABELS, sessionStateOf } from "@t3tools/initiatives/model";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, FlagIcon, InboxIcon, MessageSquarePlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { randomUUID } from "~/lib/utils";
import { useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { InitiativeDetail } from "./InitiativeDetail";
import { InitiativesInbox } from "./InitiativesInbox";
import { countStates } from "./initiatives.logic";
import { initiativesEnvironment } from "./initiativesState";

export const INITIATIVE_STATUS_LABELS = {
  draft: "Entwurf",
  active: "aktiv",
  paused: "pausiert",
  archived: "archiviert",
} as const;

/** The environments whose server keeps initiatives. */
export function useInitiativeEnvironments(): ReadonlyArray<EnvironmentId> {
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  return useMemo(
    () =>
      environments
        .map((environment) => environment.environmentId)
        .filter(
          (environmentId) =>
            serverConfigs.get(environmentId)?.environment.capabilities.initiatives === true,
        ),
    [environments, serverConfigs],
  );
}

export function InitiativesPage(props: {
  readonly initiativeId: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly view: "list" | "inbox";
}) {
  const navigate = useNavigate();
  const supported = useInitiativeEnvironments();
  const primary = usePrimaryEnvironmentId();
  const environmentId =
    props.environmentId && supported.includes(props.environmentId)
      ? props.environmentId
      : primary && supported.includes(primary)
        ? primary
        : (supported[0] ?? null);

  const openList = () => void navigate({ to: "/initiatives", search: {} });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          {props.initiativeId ? (
            <Button size="sm" variant="ghost" onClick={openList}>
              <ArrowLeftIcon />
              Alle Vorhaben
            </Button>
          ) : (
            <ToggleGroup
              value={[props.view]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "list" || next === "inbox") {
                  void navigate({
                    to: "/initiatives",
                    search: next === "inbox" ? { view: "inbox" } : {},
                  });
                }
              }}
            >
              <Toggle value="list" size="sm">
                <FlagIcon />
                Vorhaben
              </Toggle>
              <Toggle value="inbox" size="sm">
                <InboxIcon />
                Inbox
              </Toggle>
            </ToggleGroup>
          )}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">
                Kein verbundener Server kennt Vorhaben. Aktualisiere den Server, der deine Projekte
                hostet.
              </p>
            ) : props.initiativeId ? (
              <InitiativeDetail environmentId={environmentId} initiativeId={props.initiativeId} />
            ) : props.view === "inbox" ? (
              <InitiativesInbox environmentId={environmentId} />
            ) : (
              <InitiativeList environmentId={environmentId} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function InitiativeList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const list = useEnvironmentQuery(initiativesEnvironment.list({ environmentId, input: {} }));
  const [showArchived, setShowArchived] = useState(false);
  const initiatives = list.data?.initiatives ?? [];
  const active = initiatives.filter((entry) => entry.initiative.status !== "archived");
  const archived = initiatives.filter((entry) => entry.initiative.status === "archived");

  const open = (initiativeId: string) =>
    void navigate({ to: "/initiatives", search: { id: initiativeId, environmentId } });

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Vorhaben</h1>
        <p className="text-sm text-muted-foreground">
          Ein Vorhaben bündelt Projekte, Threads und Arbeit ohne Code unter einem Ziel. Threads, die
          du aus einem Vorhaben startest, bekommen seinen Steckbrief und laufen im Modus „Auto“.
        </p>
      </header>
      <CreateInitiativeForm environmentId={environmentId} onCreated={open} />
      {list.error ? <p className="text-sm text-destructive">{list.error}</p> : null}
      {list.isPending && !list.data ? (
        <p className="text-sm text-muted-foreground">Lade Vorhaben …</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">Noch keine Vorhaben.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((entry) => (
            <InitiativeRow key={entry.initiative.id} entry={entry} onOpen={open} />
          ))}
        </ul>
      )}
      {archived.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Button
            className="self-start"
            size="sm"
            variant="ghost"
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? "Archivierte ausblenden" : `Archivierte zeigen (${archived.length})`}
          </Button>
          {showArchived ? (
            <ul className="flex flex-col gap-2">
              {archived.map((entry) => (
                <InitiativeRow key={entry.initiative.id} entry={entry} onOpen={open} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function InitiativeRow({
  entry,
  onOpen,
}: {
  readonly entry: InitiativeSummary;
  readonly onOpen: (initiativeId: string) => void;
}) {
  const shells = useThreadShells();
  const now = Date.parse(useNowMinute());
  const homeEnvironmentId = entry.initiative.homeEnvironmentId;
  const counts = useMemo(() => {
    if (!homeEnvironmentId) return {};
    const wanted = new Set(
      entry.threads.map(
        (thread) => `${thread.environmentId ?? homeEnvironmentId}|${thread.threadId}`,
      ),
    );
    const sessions = shells
      .filter((shell) => wanted.has(`${shell.environmentId}|${shell.id}`))
      .map((shell) => ({ state: sessionStateOf(shell, now) }));
    return countStates(sessions);
  }, [entry.threads, homeEnvironmentId, shells, now]);
  const { initiative } = entry;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(initiative.id)}
        className="flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/40"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{initiative.title}</span>
          {initiative.status !== "active" ? (
            <Badge variant="secondary">{INITIATIVE_STATUS_LABELS[initiative.status]}</Badge>
          ) : null}
          {(["waiting", "stalled", "running"] as const).map((state) =>
            counts[state] ? (
              <Badge key={state} variant={state === "running" ? "info" : "warning"}>
                {counts[state]} {SESSION_STATE_LABELS[state]}
              </Badge>
            ) : null,
          )}
        </span>
        {initiative.goalText ? (
          <span className="line-clamp-2 text-sm text-muted-foreground">{initiative.goalText}</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {entry.projects.length === 1 ? "1 Projekt" : `${entry.projects.length} Projekte`} ·{" "}
          {entry.sessionCount === 1 ? "1 Session" : `${entry.sessionCount} Sessions`}
        </span>
      </button>
    </li>
  );
}

function CreateInitiativeForm({
  environmentId,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onCreated: (initiativeId: string) => void;
}) {
  const navigate = useNavigate();
  const act = useAtomCommand(initiativesEnvironment.act);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);

  // The usual way in: a setup chat that becomes the initiative's coordinator.
  const startChat = async () => {
    if (busy) return;
    setBusy(true);
    const result = await act({
      environmentId,
      input: { type: "createWithChat", key: randomUUID() },
    });
    setBusy(false);
    if (result._tag === "Success" && result.value.id) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: ThreadId.make(result.value.id) },
      });
    }
  };

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={() => void startChat()}>
            <MessageSquarePlusIcon />
            Vorhaben anlegen
          </Button>
          <Button size="sm" variant="link" onClick={() => setOpen(true)}>
            Ohne Chat anlegen
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Startet einen Chat, der mit dir Name, Ziele, Anweisungen und einen ersten Arbeitsplan
          klärt und danach das Vorhaben koordiniert.
        </p>
      </div>
    );
  }

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const result = await act({
      environmentId,
      input: { type: "create", title: title.trim(), goalText: goal.trim() },
    });
    setBusy(false);
    if (result._tag === "Success" && result.value.id) {
      setOpen(false);
      setTitle("");
      setGoal("");
      onCreated(result.value.id);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        placeholder="Name, z. B. Relaunch Website"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        placeholder={
          "Ziel: Woran erkennst du, dass das Vorhaben fertig ist? z. B.\n- Neue Startseite ist live"
        }
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Name und Ziel gehen jedem Thread des Vorhabens mit. Anweisungen und Projekte ergänzt du auf
        der Vorhaben-Seite.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
        <Button type="submit" disabled={!title.trim() || busy}>
          Anlegen
        </Button>
      </div>
    </form>
  );
}
