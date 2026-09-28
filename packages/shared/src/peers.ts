/**
 * Fork: peers helpers the server and the clients share: contact links and the
 * text a received message becomes in a thread.
 */
import { PEERS_INVITE_PATH, type PeerMessage } from "@t3tools/contracts";

/**
 * An http(s) origin plus optional path prefix, without a trailing slash, or
 * null when the text is no such URL. Query and fragment are dropped.
 */
export function normalizePeerBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

export function buildPeerInviteLink(baseUrl: string, secret: string): string {
  return `${baseUrl}${PEERS_INVITE_PATH}#${secret}`;
}

/** The address and secret in a contact link, or null when it is none. */
export function parsePeerInviteLink(
  link: string,
): { readonly baseUrl: string; readonly secret: string } | null {
  const trimmed = link.trim();
  const hash = trimmed.indexOf("#");
  if (hash < 0) return null;
  const secret = trimmed.slice(hash + 1).trim();
  const address = trimmed.slice(0, hash);
  if (!secret || !address.endsWith(PEERS_INVITE_PATH)) return null;
  const baseUrl = normalizePeerBaseUrl(address.slice(0, -PEERS_INVITE_PATH.length) || "/");
  return baseUrl ? { baseUrl, secret } : null;
}

/**
 * A received message as it goes into a thread: who sent it, what it is about,
 * the text quoted, and how the agent answers it.
 */
export function formatPeerMessageForThread(
  message: Pick<PeerMessage, "id" | "text" | "context">,
  senderName: string,
): string {
  const quote = (text: string) =>
    text
      .trim()
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  const parts = [`**Message from ${senderName}**`];
  if (message.context?.trim()) parts.push(`Context:\n${quote(message.context)}`);
  parts.push(quote(message.text));
  parts.push(
    `(Peer message ${message.id}. To answer it, call send_to_contact with reply_to "${message.id}".)`,
  );
  return parts.join("\n\n");
}

/** The first line of a message, shortened for a notification or a list. */
export function peerMessageExcerpt(text: string, max = 140): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
