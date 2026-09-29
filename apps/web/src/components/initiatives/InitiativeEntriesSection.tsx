/**
 * Fork: an initiative's entries: its decisions, assumptions, issues, tasks
 * and the rest of the log, with who wrote them and what replaced them. Inbox
 * questions are answered in their coordinator's Inbox; everything else moves
 * on here through its statuses.
 */
import type {
  EnvironmentId,
  Initiative,
  InitiativeEntry,
  InitiativeEntryLink,
  InitiativeEntryType,
} from "@t3tools/contracts";
import {
  ENTRY_STATUS_LABELS,
  ENTRY_STATUSES,
  ENTRY_TYPE_LABELS,
  isEntryOpen,
} from "@t3tools/initiatives/model";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { authorLabel, useOpenInbox } from "./InitiativesInbox";
import { initiativesEnvironment } from "./initiativesState";
import { canBeDone, TaskCheckBadge, TaskCheckDetails } from "./InitiativeTaskCheck";

type Filter = "open" | "decision" | "all";

const CREATABLE: ReadonlyArray<InitiativeEntryType> = [
  "decision",
  "assumption",
  "issue",
  "task",
  "plan",
  "idea",
  "insight",
  "risk",
];

export function InitiativeEntriesSection({
  environmentId,
  initiative,
  entries,
  links,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
  readonly entries: ReadonlyArray<InitiativeEntry>;
  readonly links: ReadonlyArray<InitiativeEntryLink>;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [creating, setCreating] = useState(false);
  const shown = useMemo(
    () =>
      entries
        .filter((entry) =>
          filter === "open"
            ? isEntryOpen(entry) || entry.details["needsReview"] === true
            : filter === "decision"
              ? entry.type === "decision"
              : true,
        )
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries, filter],
  );
  const titles = useMemo(() => new Map(entries.map((entry) => [entry.id, entry.title])), [entries]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Einträge</h2>
        <ToggleGroup
          value={[filter]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "open" || next === "decision" || next === "all") setFilter(next);
          }}
        >
          <Toggle value="open" size="sm">
            Offen
          </Toggle>
          <Toggle value="decision" size="sm">
            Entscheidungen
          </Toggle>
          <Toggle value="all" size="sm">
            Alle
          </Toggle>
        </ToggleGroup>
        <Button size="xs" variant="ghost" onClick={() => setCreating((value) => !value)}>
          <PlusIcon />
          Eintrag
        </Button>
      </div>
      {creating ? (
        <CreateEntryForm
          environmentId={environmentId}
          initiativeId={initiative.id}
          onDone={() => setCreating(false)}
        />
      ) : null}
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filter === "open" ? "Nichts offen." : "Noch keine Einträge."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {shown.map((entry) => (
            <EntryRow
              key={entry.id}
              environmentId={environmentId}
              entry={entry}
              related={links
                .filter((link) => link.fromId === entry.id)
                .map((link) => ({ kind: link.kind, title: titles.get(link.toId) ?? link.toId }))}
              supersededTitle={entry.supersedes ? (titles.get(entry.supersedes) ?? null) : null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const LINK_LABELS: Record<InitiativeEntryLink["kind"], string> = {
  dependsOn: "beruht auf",
  relatesTo: "gehört zu",
  implements: "setzt um",
  answers: "beantwortet",
  blocks: "blockiert",
};

function EntryRow({
  environmentId,
  entry,
  related,
  supersededTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: InitiativeEntry;
  readonly related: ReadonlyArray<{
    readonly kind: InitiativeEntryLink["kind"];
    readonly title: string;
  }>;
  readonly supersededTitle: string | null;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const openInbox = useOpenInbox();
  const [expanded, setExpanded] = useState(false);
  const statuses = ENTRY_STATUSES[entry.type] as ReadonlyArray<string>;
  const needsReview = entry.details["needsReview"] === true;
  return (
    <li className="flex flex-col gap-1 p-2 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="outline">{ENTRY_TYPE_LABELS[entry.type]}</Badge>
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer truncate text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          {entry.title}
        </button>
        {needsReview ? <Badge variant="warning">prüfen</Badge> : null}
        <TaskCheckBadge entry={entry} />
        {entry.inbox ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => openInbox(environmentId, entry.inbox!.threadId)}
          >
            In der Inbox beantworten
          </Button>
        ) : (
          <Select
            value={entry.status}
            onValueChange={(value) => {
              if (typeof value === "string" && value !== entry.status) {
                void act({
                  environmentId,
                  input: { type: "entryStatus", entryId: entry.id, status: value },
                });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Status">
              <SelectValue>{ENTRY_STATUS_LABELS[entry.status] ?? entry.status}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {statuses.map((status) => (
                <SelectItem
                  key={status}
                  hideIndicator
                  value={status}
                  disabled={status === "done" && !canBeDone(entry)}
                >
                  {ENTRY_STATUS_LABELS[status] ?? status}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-1 pl-1 text-xs text-muted-foreground">
          {entry.bodyMd ? (
            <p className="whitespace-pre-wrap text-foreground">{entry.bodyMd}</p>
          ) : null}
          {typeof entry.details["choice"] === "string" ? (
            <p>Wahl: {entry.details["choice"]}</p>
          ) : null}
          {related.map((link) => (
            <p key={`${link.kind}:${link.title}`}>
              {LINK_LABELS[link.kind]}: {link.title}
            </p>
          ))}
          {supersededTitle ? <p>ersetzt: {supersededTitle}</p> : null}
          <TaskCheckDetails environmentId={environmentId} entry={entry} />
          <p>
            {authorLabel(entry.createdBy)} · {new Date(entry.createdAt).toLocaleString("de-DE")}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function CreateEntryForm({
  environmentId,
  initiativeId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly initiativeId: string;
  readonly onDone: () => void;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const [type, setType] = useState<InitiativeEntryType>("decision");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = async () => {
    if (!title.trim()) return;
    const result = await act({
      environmentId,
      input: {
        type: "entryCreate",
        initiativeId,
        entryType: type,
        title: title.trim(),
        bodyMd: body,
      },
    });
    if (result._tag === "Success") onDone();
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-2">
        <Select
          value={type}
          onValueChange={(value) => {
            if (typeof value === "string" && (CREATABLE as ReadonlyArray<string>).includes(value)) {
              setType(value as InitiativeEntryType);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Art">
            <SelectValue>{ENTRY_TYPE_LABELS[type]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {CREATABLE.map((candidate) => (
              <SelectItem key={candidate} hideIndicator value={candidate}>
                {ENTRY_TYPE_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          autoFocus
          className="flex-1"
          placeholder="Titel, z. B. Kontaktformular braucht Spamschutz"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <Textarea
        placeholder={
          type === "decision" ? "Begründung (deine Entscheidung gilt sofort)" : "Details"
        }
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Abbrechen
        </Button>
        <Button type="submit" size="sm" disabled={!title.trim()}>
          Anlegen
        </Button>
      </div>
    </form>
  );
}
