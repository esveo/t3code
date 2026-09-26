/**
 * Fork: the brain of an initiative on its page: the pages with their layer
 * and lock, one page open to read, correct and see its history. A person's
 * correction locks the page against agents until it is unlocked here.
 */
import type {
  EnvironmentId,
  Initiative,
  InitiativeBrainLayer,
  InitiativeBrainPage,
} from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { initiativesEnvironment } from "./initiativesState";

export const BRAIN_LAYER_LABELS: Record<InitiativeBrainLayer, string> = {
  steckbrief: "Steckbrief",
  index: "Index",
  handoff: "Übergabe",
  detail: "Detail",
};

const LAYER_ORDER: ReadonlyArray<InitiativeBrainLayer> = [
  "steckbrief",
  "handoff",
  "index",
  "detail",
];

export function InitiativeBrainSection({
  environmentId,
  initiative,
  pages,
  brainError,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly pages: ReadonlyArray<InitiativeBrainPage>;
  readonly brainError: string | null;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [newPath, setNewPath] = useState<string | null>(null);
  const sorted = pages.toSorted(
    (a, b) =>
      LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || a.path.localeCompare(b.path),
  );
  const open = openPath ? (pages.find((page) => page.path === openPath) ?? null) : null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Gehirn</h2>
        <Button size="xs" variant="ghost" onClick={() => setNewPath("details/")}>
          <PlusIcon />
          Neue Seite
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Wissen des Vorhabens in einem eigenen Git-Repo, für jeden Agenten lesbar. Deine Korrektur
        sperrt eine Seite für Agenten.
      </p>
      {brainError ? (
        <p className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          Gehirn: {brainError}
        </p>
      ) : null}
      {newPath !== null ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const path = newPath.trim().endsWith(".md") ? newPath.trim() : `${newPath.trim()}.md`;
            setOpenPath(path);
            setNewPath(null);
          }}
        >
          <Input
            autoFocus
            className="flex-1"
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            aria-label="Pfad der neuen Seite"
          />
          <Button type="submit" size="sm">
            Anlegen
          </Button>
        </form>
      ) : null}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {sorted.map((page) => (
          <li key={page.id}>
            <button
              type="button"
              onClick={() => setOpenPath(openPath === page.path ? null : page.path)}
              className="flex w-full cursor-pointer items-center gap-2 p-2 text-left text-sm hover:bg-accent/40"
            >
              <Badge variant={page.layer === "detail" ? "outline" : "secondary"}>
                {BRAIN_LAYER_LABELS[page.layer]}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{page.title}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{page.path}</span>
              {page.lockedBy ? <LockIcon className="size-3.5 text-muted-foreground" /> : null}
            </button>
          </li>
        ))}
      </ul>
      {openPath ? (
        <BrainPageEditor
          key={openPath}
          environmentId={environmentId}
          initiative={initiative}
          path={openPath}
          page={open}
          onClose={() => setOpenPath(null)}
        />
      ) : null}
    </section>
  );
}

function BrainPageEditor({
  environmentId,
  initiative,
  path,
  page,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly path: string;
  readonly page: InitiativeBrainPage | null;
  readonly onClose: () => void;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const content = useEnvironmentQuery(
    initiativesEnvironment.brainPage({
      environmentId,
      input: { initiativeId: initiative.id, path },
    }),
  );
  const { refresh } = content;
  // A new commit (someone else's write) reloads the page.
  const lastCommit = page?.lastCommit ?? null;
  useEffect(() => {
    if (lastCommit) refresh();
  }, [lastCommit, refresh]);
  const [draft, setDraft] = useState<string | null>(null);
  const markdown = draft ?? content.data?.markdown ?? "";

  const save = async () => {
    if (draft === null) return;
    const result = await act({
      environmentId,
      input: { type: "brainWrite", initiativeId: initiative.id, path, markdown: draft },
    });
    if (result._tag === "Success") setDraft(null);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
        {page?.lockedBy ? (
          <Button
            size="xs"
            variant="ghost"
            title={`Gesperrt durch ${page.lockedBy}`}
            onClick={() =>
              void act({
                environmentId,
                input: { type: "brainUnlock", initiativeId: initiative.id, path },
              })
            }
          >
            <LockOpenIcon />
            Sperre lösen
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onClose}>
          Schließen
        </Button>
      </div>
      {content.error ? <p className="text-xs text-destructive">{content.error}</p> : null}
      <Textarea
        className="min-h-48"
        value={markdown}
        placeholder={content.isPending ? "Lade …" : "Markdown"}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={`Inhalt von ${path}`}
      />
      {draft !== null ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Verwerfen
          </Button>
          <Button size="sm" onClick={() => void save()}>
            Speichern und sperren
          </Button>
        </div>
      ) : null}
      {content.data && content.data.history.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Verlauf ({content.data.history.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {content.data.history.map((entry) => (
              <li key={entry.commit} className="flex gap-2">
                <span className="tabular-nums">{new Date(entry.at).toLocaleString("de-DE")}</span>
                <span className="truncate">{entry.author}</span>
                <span className="min-w-0 flex-1 truncate">{entry.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
