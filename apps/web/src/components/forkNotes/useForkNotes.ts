import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ForkNote,
  ForkNoteScope,
  ForkNotesAction,
  ForkNotesSnapshot,
  ForkNotesTarget,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  applyForkNotesAction,
  FORK_NOTE_SCOPES,
  type ForkNotesTargets,
  forkNotesTargetKey,
} from "./forkNotesLogic";
import { forkNotesEnvironment } from "./forkNotesState";
import { showForkNotesToast } from "./forkNotesToast";

const EMPTY: ReadonlyArray<ForkNote> = [];

export interface ForkNotesList {
  readonly target: ForkNotesTarget | null;
  readonly notes: ReadonlyArray<ForkNote>;
  readonly loaded: boolean;
  readonly error: string | null;
}

function useForkNotesQuery(environmentId: EnvironmentId | null, target: ForkNotesTarget | null) {
  return useEnvironmentQuery(
    environmentId && target ? forkNotesEnvironment.notes({ environmentId, input: target }) : null,
  );
}

/** Sends one action to the environment; failures show a toast. */
export function useForkNotesAct(environmentId: EnvironmentId | null) {
  const act = useAtomCommand(forkNotesEnvironment.act, { reportFailure: false });
  return useCallback(
    async (action: ForkNotesAction): Promise<boolean> => {
      if (!environmentId) return false;
      const result = await act({ environmentId, input: action });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        showForkNotesToast({
          type: "error",
          title: "Could not save the note",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return result._tag === "Success";
    },
    [act, environmentId],
  );
}

/**
 * The thread's three lists (thread, project, global). An action shows its
 * result at once and keeps it until the server's next list for that scope
 * arrives, or drops it when the action fails.
 */
export function useForkNotes(environmentId: EnvironmentId | null, targets: ForkNotesTargets) {
  const thread = useForkNotesQuery(environmentId, targets.thread);
  const project = useForkNotesQuery(environmentId, targets.project);
  const global = useForkNotesQuery(environmentId, targets.global);
  const queries = { thread, project, global };
  const send = useForkNotesAct(environmentId);

  // Optimistic lists, each valid while the server still sends the snapshot it was made from.
  const [pending, setPending] = useState<
    ReadonlyMap<
      string,
      { readonly base: ForkNotesSnapshot | null; readonly notes: ReadonlyArray<ForkNote> }
    >
  >(new Map());

  const lists = {} as Record<ForkNoteScope, ForkNotesList>;
  for (const scope of FORK_NOTE_SCOPES) {
    const target = targets[scope];
    const query = queries[scope];
    const local = target ? pending.get(forkNotesTargetKey(target)) : undefined;
    lists[scope] = {
      target,
      notes: local && local.base === query.data ? local.notes : (query.data?.notes ?? EMPTY),
      loaded: target === null || query.isSuccess,
      error: target ? query.error : null,
    };
  }
  const latest = useRef({ lists, queries });
  useEffect(() => {
    latest.current = { lists, queries };
  });

  const act = useCallback(
    async (action: ForkNotesAction) => {
      const { lists: current, queries: currentQueries } = latest.current;
      const held = new Map<string, ReadonlyArray<ForkNote>>();
      const bases = new Map<string, ForkNotesSnapshot | null>();
      for (const scope of FORK_NOTE_SCOPES) {
        const target = current[scope].target;
        if (!target) continue;
        held.set(forkNotesTargetKey(target), current[scope].notes);
        bases.set(forkNotesTargetKey(target), currentQueries[scope].data);
      }
      const changed = applyForkNotesAction(held, action, new Date().toISOString());
      setPending((previous) => {
        const next = new Map(previous);
        for (const [key, notes] of changed) next.set(key, { base: bases.get(key) ?? null, notes });
        return next;
      });
      const ok = await send(action);
      if (!ok) {
        setPending((previous) => {
          const next = new Map(previous);
          for (const key of changed.keys()) next.delete(key);
          return next;
        });
      }
      return ok;
    },
    [send],
  );

  return { lists, act };
}
