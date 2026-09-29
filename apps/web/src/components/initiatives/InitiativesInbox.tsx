/**
 * Fork: the Inbox over every initiative: open questions and tasks for the
 * user, grouped by initiative ("Ohne Zuordnung" for those of none), and the
 * decisions and rules agents proposed. Questions are answered in their
 * coordinator's Inbox panel, which keeps drafts, the outbox and delivery to
 * the right thread; a proposed decision or rule is settled right here.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, InitiativesInboxSnapshot, ThreadId } from "@t3tools/contracts";
import { ENTRY_TYPE_LABELS } from "@t3tools/initiatives/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { initiativesEnvironment } from "./initiativesState";

type InboxItem = InitiativesInboxSnapshot["items"][number];

/** Opens a coordinator thread with its Inbox panel. */
export function useOpenInbox() {
  const navigate = useNavigate();
  return useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "thread-inbox");
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    },
    [navigate],
  );
}

/** Who wrote an entry, in words. */
export function authorLabel(author: string): string {
  if (author.startsWith("person:")) return "von dir";
  if (author.startsWith("role:coordinator:")) return "vom Koordinator";
  if (author.startsWith("role:")) return "von einem Thread";
  if (author.startsWith("import:")) return "übernommen";
  return "vom System";
}

export function InitiativesInbox({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const inbox = useEnvironmentQuery(initiativesEnvironment.inbox({ environmentId, input: {} }));
  const act = useAtomCommand(initiativesEnvironment.act);
  const openInbox = useOpenInbox();
  const groups = useMemo(() => {
    const byInitiative = new Map<string, { title: string; items: Array<InboxItem> }>();
    for (const item of inbox.data?.items ?? []) {
      const key = item.initiativeId ?? "";
      const group = byInitiative.get(key) ?? {
        title: item.initiativeTitle ?? "Ohne Zuordnung",
        items: [],
      };
      group.items.push(item);
      byInitiative.set(key, group);
    }
    // Initiatives first, the unassigned ones last.
    return [...byInitiative.entries()].toSorted(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : 0));
  }, [inbox.data]);

  if (inbox.error) return <p className="text-sm text-destructive">{inbox.error}</p>;
  if (!inbox.data) return <p className="text-sm text-muted-foreground">Lade Inbox …</p>;

  return (
    <div className="flex flex-col gap-5">
      <GlobalStop environmentId={environmentId} />
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nichts wartet auf dich.</p>
      ) : null}
      {groups.map(([key, group]) => (
        <section key={key || "none"} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            {group.title} <span className="text-muted-foreground">({group.items.length})</span>
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {group.items.map(({ entry }) => (
              <li key={entry.id} className="flex items-center gap-2 p-2 text-sm">
                <Badge variant={entry.urgency === "now" ? "warning" : "outline"}>
                  {entry.inbox
                    ? ENTRY_TYPE_LABELS[entry.type]
                    : entry.type === "rule"
                      ? "Regel-Vorschlag"
                      : "Vorschlag"}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                {entry.snoozedAt ? <Badge variant="secondary">zurückgestellt</Badge> : null}
                <span className="text-xs text-muted-foreground">
                  {authorLabel(entry.createdBy)}
                </span>
                {entry.inbox ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => openInbox(environmentId, entry.inbox!.threadId)}
                  >
                    Beantworten
                  </Button>
                ) : (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        void act({
                          environmentId,
                          input: {
                            type: "entryStatus",
                            entryId: entry.id,
                            status: entry.type === "rule" ? "active" : "valid",
                          },
                        })
                      }
                    >
                      {entry.type === "rule" ? "Übernehmen" : "Gilt"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void act({
                          environmentId,
                          input: {
                            type: "entryStatus",
                            entryId: entry.id,
                            status: entry.type === "rule" ? "dismissed" : "reopened",
                          },
                        })
                      }
                    >
                      {entry.type === "rule" ? "Verwerfen" : "Nicht so"}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The stop of every initiative at once, in two stages: the Not-Aus keeps any
 * initiative from starting a thread; "Alles anhalten" also interrupts the
 * initiatives' threads that are working now.
 */
function GlobalStop({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const list = useEnvironmentQuery(initiativesEnvironment.list({ environmentId, input: {} }));
  const act = useAtomCommand(initiativesEnvironment.act);
  const halted = list.data?.halted === true;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {halted
          ? "Not-Aus ist an: kein Vorhaben startet Threads. Laufende Threads laufen weiter, bis du alles anhältst."
          : "Not-Aus: kein Vorhaben startet dann Threads. „Alles anhalten“ unterbricht zusätzlich die laufenden."}
      </span>
      <Button
        size="sm"
        variant={halted ? "outline" : "destructive-outline"}
        onClick={() =>
          void act({
            environmentId,
            input: { type: "setHalt", initiativeId: null, halted: !halted },
          })
        }
      >
        {halted ? "Not-Aus lösen" : "Not-Aus"}
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        onClick={() => void act({ environmentId, input: { type: "stopAll", initiativeId: null } })}
      >
        Alles anhalten
      </Button>
    </div>
  );
}
