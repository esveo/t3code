/**
 * Fork: the overview's short view of the learning loop and the task graph:
 * the active rules every new thread starts with, numbered as in its prompt,
 * and the tasks that could start now. Nothing here starts a thread.
 */
import type { EnvironmentId, InitiativeEntry, InitiativeEntryLink } from "@t3tools/contracts";
import { activeRules, taskGraph } from "@t3tools/initiatives/model";
import { useMemo } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { TaskDependencies } from "./InitiativeEntriesSection";
import { initiativesEnvironment } from "./initiativesState";

export function InitiativeRulesOverview({
  environmentId,
  entries,
  links,
}: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<InitiativeEntry>;
  readonly links: ReadonlyArray<InitiativeEntryLink>;
}) {
  const act = useAtomCommand(initiativesEnvironment.act);
  const rules = useMemo(() => activeRules(entries), [entries]);
  const proposed = entries.filter((entry) => entry.type === "rule" && entry.status === "proposed");
  const ready = useMemo(() => {
    const graph = taskGraph(entries, links);
    return entries.flatMap((entry) => {
      const node = graph.get(entry.id);
      return node?.ready ? [{ entry, node }] : [];
    });
  }, [entries, links]);

  return (
    <>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Regeln</h2>
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Noch keine Regeln. Jede aktive Regel bekommen der Koordinator und jeder neue Thread des
            Vorhabens mit.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {rules.map((rule, index) => (
              <li key={rule.id} className="flex items-center gap-2 p-2 text-sm">
                <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                <span className="min-w-0 flex-1">{rule.title}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void act({
                      environmentId,
                      input: { type: "entryStatus", entryId: rule.id, status: "revoked" },
                    })
                  }
                >
                  Aufheben
                </Button>
              </li>
            ))}
          </ol>
        )}
        {proposed.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {proposed.length === 1
              ? "1 vorgeschlagene Regel wartet in der Inbox."
              : `${proposed.length} vorgeschlagene Regeln warten in der Inbox.`}
          </p>
        ) : null}
      </section>
      {ready.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Startbereit</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {ready.map(({ entry, node }) => (
              <li key={entry.id} className="flex flex-col gap-1 p-2 text-sm">
                <span className="truncate">{entry.title}</span>
                {node.dependsOn.length > 0 ? <TaskDependencies task={node} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
