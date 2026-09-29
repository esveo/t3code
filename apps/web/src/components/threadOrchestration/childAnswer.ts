import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadUpdates } from "@t3tools/shared/threadOrchestration";
import { Atom } from "effect/unstable/reactivity";

import { useProject, useThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";

/**
 * Fork: the coordinator's newest user message when it is a bundle of child
 * updates, else null. It changes only when that id does, so a streaming answer
 * does not re-render the update cards.
 */
const latestUpdateMessageIdAtom = Atom.family((key: string) =>
  Atom.make((get): string | null => {
    const rows = get(environmentThreadDetails.visibleTurnItemsAtom(parseThreadKey(key)));
    const latestUserMessage = rows.findLast((row) => row.item.type === "user_message")?.item;
    return latestUserMessage?.type === "user_message" && parseThreadUpdates(latestUserMessage.text)
      ? latestUserMessage.messageId
      : null;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`fork-latest-thread-update:${key}`)),
);

const NO_LATEST_UPDATE_ATOM = Atom.make(null);

/** Whether a coordinator's message is its newest one and carries child updates. */
export function useIsLatestThreadUpdate(
  coordinatorRef: ScopedThreadRef | null,
  messageId: string | undefined,
): boolean {
  const latestId = useAtomValue(
    coordinatorRef ? latestUpdateMessageIdAtom(threadKey(coordinatorRef)) : NO_LATEST_UPDATE_ATOM,
  );
  return messageId !== undefined && latestId === messageId;
}

/**
 * The directory a child's answer is written against: its worktree, else its
 * project. Updates carry the child's full answer; its relative paths and
 * images resolve from here.
 */
export function useChildAnswerCwd(childRef: ScopedThreadRef): string | undefined {
  const shell = useThreadShell(childRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  return shell?.worktreePath ?? project?.workspaceRoot ?? undefined;
}
