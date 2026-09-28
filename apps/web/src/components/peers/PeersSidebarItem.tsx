/**
 * Fork: the Peers entry among the sidebar's utility buttons, with the number
 * of unread messages, and the notifier that announces new ones.
 */
import { peerMessageExcerpt } from "@t3tools/shared/peers";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PeerMessage } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { contactName, newlyReceived, totalUnread } from "./peers.logic";
import { usePeersEnvironmentId, usePeersSnapshot } from "./usePeers";

export function PeersSidebarItem() {
  const navigate = useNavigate();
  const environmentId = usePeersEnvironmentId();
  const { snapshot } = usePeersSnapshot(environmentId);
  if (!environmentId) return null;
  const unread = snapshot ? totalUnread(snapshot.messages) : 0;
  const label = unread > 0 ? `Peers (${unread} unread)` : "Peers";
  return (
    <SidebarMenuItem className="relative shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={() => void navigate({ to: "/peers" })}
              size="icon"
            >
              <MessagesSquareIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {unread > 0 ? (
        <span className="pointer-events-none absolute -top-1 -right-1">
          <Badge size="sm">{unread}</Badge>
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}

/** Announces received messages: a toast while the app is in front, a system notification otherwise. */
export function PeersNotifier() {
  const navigate = useNavigate();
  const environmentId = usePeersEnvironmentId();
  const { snapshot } = usePeersSnapshot(environmentId);
  const previous = useRef<ReadonlyArray<PeerMessage> | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const arrived = newlyReceived(previous.current, snapshot.messages);
    previous.current = snapshot.messages;
    for (const message of arrived) {
      const sender = contactName(snapshot.contacts, message.contactId);
      const title = `Message from ${sender}`;
      const body = peerMessageExcerpt(message.text);
      // An answer opens the thread that asked, where it waits as a card.
      const open = () =>
        void (message.threadId && environmentId
          ? navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: message.threadId },
            })
          : navigate({ to: "/peers", search: { contact: message.contactId } }));
      const inFront = document.visibilityState === "visible" && document.hasFocus();
      if (inFront || typeof Notification === "undefined" || Notification.permission !== "granted") {
        const toastId = toastManager.add({
          type: "info",
          title,
          description: body,
          actionProps: {
            children: message.threadId ? "Open thread" : "Open Peers",
            onClick: () => {
              toastManager.close(toastId);
              open();
            },
          },
        });
        continue;
      }
      try {
        const notification = new Notification(title, { body, tag: `peers:${message.id}` });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          open();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [environmentId, navigate, snapshot]);

  return null;
}
