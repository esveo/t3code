/**
 * Fork: answers from contacts to messages this thread sent, above its
 * composer until the user takes them over or puts them away.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { peerMessageExcerpt } from "@t3tools/shared/peers";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { contactName, openRepliesForThread } from "./peers.logic";
import {
  useAdoptPeerMessage,
  usePeersAct,
  usePeersEnvironmentId,
  usePeersSnapshot,
} from "./usePeers";

export function PeerReplyCards({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const peersEnvironmentId = usePeersEnvironmentId();
  const environmentId = peersEnvironmentId === threadRef.environmentId ? peersEnvironmentId : null;
  const { snapshot } = usePeersSnapshot(environmentId);
  const run = usePeersAct(environmentId);
  const adopt = useAdoptPeerMessage(environmentId, snapshot);
  const replies = useMemo(
    () => (snapshot ? openRepliesForThread(snapshot.messages, threadRef.threadId) : []),
    [snapshot, threadRef.threadId],
  );
  if (!snapshot || replies.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-2">
      {replies.map((message) => (
        <div
          key={message.id}
          className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2 shadow-xs/5"
        >
          <MessagesSquareIcon className="mt-0.5 size-4 shrink-0 text-info-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Answer from {contactName(snapshot.contacts, message.contactId)}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {peerMessageExcerpt(message.text)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={() => void adopt(message, threadRef.threadId)}>
              {snapshot.adoptMode === "send" ? "Send to agent" : "Take over"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(
                  { type: "setStatus", messageId: message.id, status: "done" },
                  "Could not update the message",
                )
              }
            >
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
