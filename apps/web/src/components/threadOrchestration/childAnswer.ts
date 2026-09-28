import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { OrchestrationMessage, ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadUpdates } from "@t3tools/shared/threadOrchestration";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useProject, useThreadDetail, useThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";

/**
 * Fork: the coordinator's newest user message when it is a bundle of child
 * updates, else null. It changes only when that id does, so a streaming answer
 * does not re-render the update cards.
 */
const latestUpdateMessageIdAtom = Atom.family((key: string) =>
  Atom.make((get): OrchestrationMessage["id"] | null => {
    const messages = get(environmentThreadDetails.messagesAtom(parseThreadKey(key)));
    const latestUserMessage = messages.findLast((message) => message.role === "user");
    return latestUserMessage && parseThreadUpdates(latestUserMessage.text)
      ? latestUserMessage.id
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
 * The child's full answer an update summarizes, and the directory its paths
 * are relative to (its worktree, else its project). Pass `load: false` to skip
 * the child's detail subscription while the answer is not shown.
 */
export function useChildAnswer(input: {
  childRef: ScopedThreadRef;
  answerId: string | null;
  load: boolean;
}): { text: string | null; cwd: string | undefined } {
  const shell = useThreadShell(input.childRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  const detail = useThreadDetail(input.load && input.answerId ? input.childRef : null);
  const text = useMemo(
    () => detail?.messages.find((message) => message.id === input.answerId)?.text ?? null,
    [detail?.messages, input.answerId],
  );
  return { text, cwd: shell?.worktreePath ?? project?.workspaceRoot ?? undefined };
}
