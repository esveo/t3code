/**
 * Fork: the loop of a task or plan in the entries list. A badge says where its
 * acceptance check stands (a task without one gets a hint); the opened row
 * shows the check, its reported results with evidence, the returns to its
 * thread, and lets the user define the check, accept without one, hand the
 * task back or mark its work as rolled back.
 */
import type { EnvironmentId, InitiativeAcceptanceCheck, InitiativeEntry } from "@t3tools/contracts";
import {
  ACCEPTANCE_CHECK_KIND_LABELS,
  CHECK_STATE_LABELS,
  type CheckState,
  checkStateOf,
  describeCheck,
  isCheckedEntry,
  MAX_RETURN_ATTEMPTS,
  taskDoneBlocker,
} from "@t3tools/initiatives/model";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { authorLabel } from "./InitiativesInbox";
import { initiativesEnvironment } from "./initiativesState";

const BADGE_VARIANTS: Record<CheckState, "success" | "error" | "warning" | "outline"> = {
  missing: "warning",
  pending: "outline",
  passed: "success",
  failed: "error",
  acceptedWithout: "warning",
};

/** Whether the status select may offer done; the server refuses it otherwise. */
export const canBeDone = (entry: InitiativeEntry) => taskDoneBlocker(entry) === null;

export function TaskCheckBadge({ entry }: { readonly entry: InitiativeEntry }) {
  if (!isCheckedEntry(entry)) return null;
  const state = checkStateOf(entry);
  const attempts = entry.attempts ?? 0;
  return (
    <>
      {attempts > 0 ? (
        <Badge variant={attempts >= MAX_RETURN_ATTEMPTS ? "error" : "outline"}>
          Versuch {attempts}/{MAX_RETURN_ATTEMPTS}
        </Badge>
      ) : null}
      {entry.rolledBackBy ? <Badge variant="error">zurückgedreht</Badge> : null}
      <Badge variant={BADGE_VARIANTS[state]}>{CHECK_STATE_LABELS[state]}</Badge>
    </>
  );
}

export function TaskCheckDetails({
  environmentId,
  entry,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: InitiativeEntry;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const [editing, setEditing] = useState(false);
  const [returning, setReturning] = useState(false);
  if (!isCheckedEntry(entry)) return null;
  const check = entry.acceptanceCheck ?? null;
  const isTask = entry.type === "task";
  const lastEscalation = entry.returns?.findLast((item) => item.escalated);
  return (
    <div className="flex flex-col gap-1 border-l border-border pl-2">
      {check ? (
        <p className="text-foreground">
          Check ({ACCEPTANCE_CHECK_KIND_LABELS[check.kind]}): {describeCheck(check)}
        </p>
      ) : (
        <p className="text-warning-foreground">
          {isTask
            ? "Kein Check: dieser Task wird erst erledigt, wenn ein Check besteht oder du ihn ohne Check abnimmst."
            : "Kein Check festgelegt."}
        </p>
      )}
      {(entry.checkResults ?? []).map((result) => (
        <p key={result.reportedAt}>
          {result.outcome === "passed" ? "bestanden" : "gescheitert"} ·{" "}
          {authorLabel(result.reportedBy)} · {new Date(result.reportedAt).toLocaleString("de-DE")}
          {result.evidence.excerpt ? (
            <code className="block whitespace-pre-wrap">{result.evidence.excerpt}</code>
          ) : null}
          {result.evidence.url ? (
            <a
              className="block underline"
              href={result.evidence.url}
              target="_blank"
              rel="noreferrer"
            >
              {result.evidence.url}
            </a>
          ) : null}
          {result.evidence.commit ? (
            <span className="block">Commit {result.evidence.commit}</span>
          ) : null}
        </p>
      ))}
      {entry.acceptedWithoutCheckBy ? (
        <p>Ohne Check abgenommen von {authorLabel(entry.acceptedWithoutCheckBy)}.</p>
      ) : null}
      {(entry.returns ?? []).map((item) => (
        <p key={item.at}>
          {item.escalated ? "Eskaliert (Frage in der Inbox)" : "Zurückgegeben"} ·{" "}
          {new Date(item.at).toLocaleString("de-DE")}: {item.finding} — Umfang: {item.scope}
        </p>
      ))}
      {lastEscalation ? (
        <p className="text-warning-foreground">
          Nach {MAX_RETURN_ATTEMPTS} Korrekturen gibt der Koordinator nicht mehr selbst zurück; der
          Fehler liegt vermutlich im Plan.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button size="xs" variant="ghost" onClick={() => setEditing((value) => !value)}>
          {check ? "Check ändern" : "Check festlegen"}
        </Button>
        {isTask && entry.status !== "done" && !canBeDone(entry) ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void act({
                environmentId,
                input: { type: "entryAcceptWithoutCheck", entryId: entry.id },
              })
            }
          >
            Ohne Check abnehmen
          </Button>
        ) : null}
        {isTask ? (
          <Button size="xs" variant="ghost" onClick={() => setReturning((value) => !value)}>
            Zurückgeben
          </Button>
        ) : null}
        {isTask ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void act({
                environmentId,
                input: {
                  type: "markRolledBack",
                  target: "entry",
                  id: entry.id,
                  rolledBack: !entry.rolledBackBy,
                },
              })
            }
          >
            {entry.rolledBackBy ? "Nicht zurückgedreht" : "Als zurückgedreht markieren"}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <CheckForm
          initial={check}
          onCancel={() => setEditing(false)}
          onSubmit={async (next) => {
            const result = await act({
              environmentId,
              input: { type: "entryCheckSet", entryId: entry.id, check: next },
            });
            if (result._tag === "Success") setEditing(false);
          }}
        />
      ) : null}
      {returning ? (
        <ReturnForm
          threadKnown={Boolean(entry.threadId)}
          onCancel={() => setReturning(false)}
          onSubmit={async (finding, scope) => {
            const result = await act({
              environmentId,
              input: { type: "entryReturn", entryId: entry.id, finding, scope },
            });
            if (result._tag === "Success") setReturning(false);
          }}
        />
      ) : null}
    </div>
  );
}

const KINDS: ReadonlyArray<InitiativeAcceptanceCheck["kind"]> = [
  "command",
  "mergedPr",
  "criterion",
];

function CheckForm({
  initial,
  onCancel,
  onSubmit,
}: {
  readonly initial: InitiativeAcceptanceCheck | null;
  readonly onCancel: () => void;
  readonly onSubmit: (check: InitiativeAcceptanceCheck) => Promise<void>;
}) {
  const [kind, setKind] = useState<InitiativeAcceptanceCheck["kind"]>(initial?.kind ?? "command");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [ref, setRef] = useState(initial?.ref ?? "");
  const [expected, setExpected] = useState(initial?.expected ?? "");
  const valid = description.trim() !== "" && (kind !== "command" || ref.trim() !== "");
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void onSubmit({
          kind,
          description: description.trim(),
          ref: ref.trim() || null,
          expected: kind === "command" ? expected.trim() || null : null,
        });
      }}
    >
      <div className="flex gap-2">
        <Select
          value={kind}
          onValueChange={(value) => {
            if (typeof value === "string" && (KINDS as ReadonlyArray<string>).includes(value)) {
              setKind(value as InitiativeAcceptanceCheck["kind"]);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Art des Checks">
            <SelectValue>{ACCEPTANCE_CHECK_KIND_LABELS[kind]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {KINDS.map((candidate) => (
              <SelectItem key={candidate} hideIndicator value={candidate}>
                {ACCEPTANCE_CHECK_KIND_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          className="flex-1"
          placeholder="Was der Check zeigt, z. B. Spam wird abgewiesen"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      {kind !== "criterion" ? (
        <Input
          placeholder={kind === "command" ? "Befehl, z. B. vp test run contact" : "Link zum PR"}
          value={ref}
          onChange={(event) => setRef(event.target.value)}
        />
      ) : null}
      {kind === "command" ? (
        <Input
          placeholder="Erwartete Ausgabe, z. B. 0 failed"
          value={expected}
          onChange={(event) => setExpected(event.target.value)}
        />
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button type="submit" size="xs" disabled={!valid}>
          Speichern
        </Button>
      </div>
    </form>
  );
}

function ReturnForm({
  threadKnown,
  onCancel,
  onSubmit,
}: {
  readonly threadKnown: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (finding: string, scope: string) => Promise<void>;
}) {
  const [finding, setFinding] = useState("");
  const [scope, setScope] = useState("");
  const valid = finding.trim() !== "" && scope.trim() !== "";
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void onSubmit(finding.trim(), scope.trim());
      }}
    >
      {threadKnown ? null : (
        <p className="text-warning-foreground">
          Der Task nennt noch keinen Thread; zurückgeben geht erst, wenn er in einem gestartet
          wurde.
        </p>
      )}
      <Textarea
        placeholder="Befund: was ist falsch, mit Beleg"
        value={finding}
        onChange={(event) => setFinding(event.target.value)}
      />
      <Input
        placeholder="Umfang: nur das ändern, z. B. Honeypot-Feld ergänzen"
        value={scope}
        onChange={(event) => setScope(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button type="submit" size="xs" disabled={!valid || !threadKnown}>
          Zurückgeben
        </Button>
      </div>
    </form>
  );
}
