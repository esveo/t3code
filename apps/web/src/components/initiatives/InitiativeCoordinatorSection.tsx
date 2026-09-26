/**
 * Fork: the initiative's coordinator: its pinned thread and its handoff. A
 * restart starts a fresh coordinator from the handoff, so it never depends on
 * the old chat; the threads of the old one then report to the new one.
 */
import type { EnvironmentId, Initiative, ThreadId } from "@t3tools/contracts";
import { SESSION_STATE_LABELS, sessionStateOf } from "@t3tools/initiatives/model";
import { Link } from "@tanstack/react-router";
import { RotateCcwIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { randomUUID } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { initiativesEnvironment } from "./initiativesState";

export function InitiativeCoordinatorSection({
  environmentId,
  initiative,
  handoffCommit,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  /** The handoff page's last commit, to reload it when the coordinator writes it. */
  readonly handoffCommit: string | null;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const shells = useThreadShells();
  const nowMs = Date.parse(useNowMinute());
  const coordinatorId = initiative.coordinatorThreadId;
  const homeEnvironmentId = initiative.homeEnvironmentId ?? environmentId;
  const shell = coordinatorId
    ? (shells.find(
        (candidate) =>
          candidate.id === coordinatorId && candidate.environmentId === homeEnvironmentId,
      ) ?? null)
    : null;
  const handoff = useEnvironmentQuery(
    initiativesEnvironment.brainPage({
      environmentId,
      input: { initiativeId: initiative.id, path: "handoff.md" },
    }),
  );
  const { refresh } = handoff;
  useEffect(() => {
    if (handoffCommit) refresh();
  }, [handoffCommit, refresh]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const archived = initiative.status === "archived";

  const start = async () => {
    setBusy(true);
    await act({
      environmentId,
      input: {
        type: "startCoordinator",
        initiativeId: initiative.id,
        key: randomUUID(),
        ...(message.trim() ? { message: message.trim() } : {}),
      },
    });
    setBusy(false);
    setMessage("");
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Koordinator</h2>
      {coordinatorId ? (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="info">{SESSION_STATE_LABELS[sessionStateOf(shell, nowMs)]}</Badge>
          {shell ? (
            <Link
              className="min-w-0 flex-1 truncate hover:underline"
              to="/$environmentId/$threadId"
              params={{ environmentId: homeEnvironmentId, threadId: coordinatorId as ThreadId }}
            >
              {shell.title}
            </Link>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Der Koordinator-Thread ist nicht mehr da.
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Der Koordinator ist ein angepinnter Thread, der die Arbeit verteilt, das Gehirn pflegt und
          am Ende jedes Turns die Übergabe schreibt. Er bekommt den Steckbrief und die Übergabe; ein
          Neustart beginnt von der Übergabe, nicht vom alten Chat.
        </p>
      )}
      {handoff.data?.markdown ? (
        <details open className="rounded-lg border border-border p-2 text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Übergabe-Dokument
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{handoff.data.markdown}</pre>
        </details>
      ) : null}
      {!archived ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={
              coordinatorId
                ? "Optional: erste Anweisung an den neuen Koordinator, z. B. „Prüf die offenen PRs und schlag den nächsten Schritt vor.“ Ohne sie macht er mit der Übergabe weiter."
                : "Optional: erste Anweisung an den Koordinator, z. B. „Teil das Ziel in drei Threads auf und frag mich vor dem Start.“"
            }
            aria-label="Erste Anweisung"
          />
          <Button className="self-end" size="sm" disabled={busy} onClick={() => void start()}>
            {coordinatorId ? <RotateCcwIcon /> : <SparklesIcon />}
            {coordinatorId ? "Neu starten aus der Übergabe" : "Koordinator starten"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
