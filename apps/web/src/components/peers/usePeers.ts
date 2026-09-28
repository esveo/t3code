import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PeerMessage,
  PeersAction,
  PeersSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { formatPeerMessageForThread } from "@t3tools/shared/peers";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { appendToPrompt, contactName } from "./peers.logic";
import { peersEnvironment } from "./peersState";

/**
 * Fork: the environment whose contacts the app shows: the primary one when it
 * keeps contacts, otherwise the first connected one that does.
 */
export function usePeersEnvironmentId(): EnvironmentId | null {
  const primary = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  return useMemo(() => {
    const supports = (id: EnvironmentId) =>
      configs.get(id)?.environment.capabilities.peers === true;
    if (primary && supports(primary)) return primary;
    for (const id of configs.keys()) if (supports(id)) return id;
    return null;
  }, [configs, primary]);
}

export function usePeersSnapshot(environmentId: EnvironmentId | null): {
  readonly snapshot: PeersSnapshot | null;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId ? peersEnvironment.snapshot({ environmentId, input: {} }) : null,
  );
  return { snapshot: query.data, error: query.error };
}

/** Runs a peers action and reports a failure as a toast; resolves whether it worked. */
export function usePeersAct(environmentId: EnvironmentId | null) {
  const act = useAtomCommand(peersEnvironment.act);
  return useCallback(
    async (input: PeersAction, failureTitle: string): Promise<boolean> => {
      if (!environmentId) return false;
      const result = await act({ environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return false;
      }
      return result._tag === "Success";
    },
    [act, environmentId],
  );
}

/** Threads a message can go to: those in the Active or Pinned list of the sidebar. */
export function usePeerTargetThreads(environmentId: EnvironmentId | null) {
  const shells = useThreadShells();
  return useMemo(
    () =>
      shells
        .filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.archivedAt === null &&
            thread.settledAt === null,
        )
        .toSorted((a, b) => {
          const pinned = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
          return pinned !== 0 ? pinned : b.updatedAt.localeCompare(a.updatedAt);
        }),
    [environmentId, shells],
  );
}

/**
 * Hands a received message to a thread the way the user chose in Peers: into
 * the thread's composer to add to and send, or straight to its agent.
 */
export function useAdoptPeerMessage(
  environmentId: EnvironmentId | null,
  snapshot: PeersSnapshot | null,
) {
  const navigate = useNavigate();
  const run = usePeersAct(environmentId);
  return useCallback(
    async (message: PeerMessage, threadId: ThreadId) => {
      if (!environmentId || !snapshot) return;
      if (snapshot.adoptMode === "send") {
        const sent = await run(
          { type: "sendToThread", messageId: message.id, threadId },
          "Could not send the message to the thread",
        );
        if (sent) toastManager.add({ type: "success", title: "Sent to the thread's agent" });
        return;
      }
      const threadRef = scopeThreadRef(environmentId, threadId);
      const store = useComposerDraftStore.getState();
      const draft = store.getComposerDraft(threadRef);
      const text = formatPeerMessageForThread(
        message,
        contactName(snapshot.contacts, message.contactId),
      );
      store.setPrompt(threadRef, appendToPrompt(draft?.prompt ?? "", text));
      await run(
        { type: "setStatus", messageId: message.id, status: "done" },
        "Could not update the message",
      );
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [environmentId, navigate, run, snapshot],
  );
}
