import type { PeerContact, PeerMessage } from "@t3tools/contracts";

/** Received messages still waiting on the user: unread or read but not handed on. */
export function isOpenIncoming(message: PeerMessage): boolean {
  return message.direction === "in" && (message.status === "unread" || message.status === "read");
}

export function unreadCountByContact(
  messages: ReadonlyArray<PeerMessage>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.direction === "in" && message.status === "unread") {
      counts.set(message.contactId, (counts.get(message.contactId) ?? 0) + 1);
    }
  }
  return counts;
}

export function totalUnread(messages: ReadonlyArray<PeerMessage>): number {
  let total = 0;
  for (const message of messages) {
    if (message.direction === "in" && message.status === "unread") total += 1;
  }
  return total;
}

/**
 * Received messages that arrived since the previous snapshot, for a
 * notification. The first snapshot announces nothing: that is history.
 */
export function newlyReceived(
  previous: ReadonlyArray<PeerMessage> | null,
  next: ReadonlyArray<PeerMessage>,
): ReadonlyArray<PeerMessage> {
  if (previous === null) return [];
  const seen = new Set(
    previous.filter((message) => message.direction === "in").map((message) => message.id),
  );
  return next.filter(
    (message) => message.direction === "in" && message.status === "unread" && !seen.has(message.id),
  );
}

/** Replies waiting in a thread: answers to messages it sent that the user has not dealt with. */
export function openRepliesForThread(
  messages: ReadonlyArray<PeerMessage>,
  threadId: string,
): ReadonlyArray<PeerMessage> {
  return messages.filter((message) => message.threadId === threadId && isOpenIncoming(message));
}

export function contactName(contacts: ReadonlyArray<PeerContact>, contactId: string): string {
  const contact = contacts.find((candidate) => candidate.id === contactId);
  if (!contact) return "Removed contact";
  return contact.isSelf ? `${contact.name} (you)` : contact.name;
}

/** Appends text to a composer draft, a blank line apart from what is already there. */
export function appendToPrompt(prompt: string, text: string): string {
  const trimmed = prompt.trimEnd();
  return trimmed ? `${trimmed}\n\n${text}\n\n` : `${text}\n\n`;
}
