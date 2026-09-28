/**
 * Fork: peers. Two environments that linked each other as contacts exchange
 * single messages: an agent sends one with `send_to_contact`, the other side
 * reads it in the contact's channel and hands it to a thread. A message that
 * answers one sent from a thread shows up in that thread by itself.
 *
 * Environments talk to each other over plain HTTP (see `PEERS_HTTP_PREFIX`),
 * authenticated with a token per contact instead of an environment session: a
 * contact may deliver messages and nothing else.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PEERS_WS_METHODS = {
  subscribe: "peers.subscribe",
  act: "peers.act",
} as const;

/** Where one environment reaches another: `<baseUrl>${PEERS_HTTP_PREFIX}/…`. */
export const PEERS_HTTP_PREFIX = "/api/fork/peers";
/** The path of a contact link; the link's fragment carries the invite secret. */
export const PEERS_INVITE_PATH = `${PEERS_HTTP_PREFIX}/invite`;

export const PEER_MESSAGE_TEXT_MAX = 50_000;
export const PEER_MESSAGE_CONTEXT_MAX = 10_000;

const PeerText = Schema.String.check(Schema.isMaxLength(PEER_MESSAGE_TEXT_MAX));
const PeerContextText = Schema.String.check(Schema.isMaxLength(PEER_MESSAGE_CONTEXT_MAX));
const PeerName = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

export const PeerContact = Schema.Struct({
  /** The contact's environment id; linking the same environment again updates it. */
  id: TrimmedNonEmptyString,
  name: PeerName,
  /** Where its server is reached; null when it gave no address, so it can only send. */
  baseUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** This environment itself, linked through its own contact link. */
  isSelf: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type PeerContact = typeof PeerContact.Type;

/**
 * Sent messages: pending (waiting in the outbox), delivered, failed.
 * Received messages: unread, read, done (handed to a thread or put away).
 */
export const PeerMessageStatus = Schema.Literals([
  "pending",
  "delivered",
  "failed",
  "unread",
  "read",
  "done",
]);
export type PeerMessageStatus = typeof PeerMessageStatus.Type;

/**
 * How automatic routing placed a received message: the threads it chose
 * from, the model's steps and reason, and where the message went.
 */
export const PeerRouting = Schema.Struct({
  decidedAt: IsoDateTime,
  /** thread: forwarded to `threadId`; stay: left in the channel for the user. */
  outcome: Schema.Literals(["thread", "stay"]),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  /** The model that decided, or null when no model was asked (an answer goes back to its thread). */
  model: Schema.NullOr(Schema.String),
  /** The model's steps, in its words. */
  steps: Schema.Array(Schema.String),
  reason: Schema.String,
  candidates: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, project: Schema.String }),
  ),
});
export type PeerRouting = typeof PeerRouting.Type;

export const PeerMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  contactId: TrimmedNonEmptyString,
  direction: Schema.Literals(["in", "out"]),
  text: Schema.String,
  /** What the message is about, written by the sender's agent for the reader. */
  context: Schema.NullOr(Schema.String),
  /** The message this one answers. */
  replyToId: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Sent: the thread whose agent sent it. Received: the thread it answers,
   * when it replies to a message sent from one; it is shown there.
   */
  threadId: Schema.NullOr(ThreadId),
  status: PeerMessageStatus,
  /** Why the last delivery failed, for sent messages. */
  error: Schema.NullOr(Schema.String),
  /** Received messages: how automatic routing placed it, when it was on. */
  routing: Schema.NullOr(PeerRouting),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PeerMessage = typeof PeerMessage.Type;

/** What a message handed to a thread does: fill the composer, or go to the agent right away. */
export const PeerAdoptMode = Schema.Literals(["composer", "send"]);
export type PeerAdoptMode = typeof PeerAdoptMode.Type;

export const PeersSnapshot = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  /** How contacts see this environment. */
  ownName: PeerName,
  /**
   * The address contacts reach this environment at; needed for a contact
   * link. The one set in Peers, or else the T3 Connect address.
   */
  ownBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** The T3 Connect address of this environment, when it has a tunnel. */
  detectedBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** The reusable contact link, once there is an address. */
  inviteLink: Schema.NullOr(Schema.String),
  adoptMode: PeerAdoptMode,
  /** Received messages go to a matching thread's agent on their own. */
  autoRoute: Schema.Boolean,
  /** The text generation model routing uses (Settings → General), for display. */
  routingModel: Schema.NullOr(Schema.String),
  contacts: Schema.Array(PeerContact),
  /** The latest messages, oldest first. */
  messages: Schema.Array(PeerMessage),
});
export type PeersSnapshot = typeof PeersSnapshot.Type;

export const PeersAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("configure"),
    ownName: Schema.optional(PeerName),
    ownBaseUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    adoptMode: Schema.optional(PeerAdoptMode),
    autoRoute: Schema.optional(Schema.Boolean),
  }),
  /** A new secret for the contact link; contacts linked with the old one stay. */
  Schema.Struct({ type: Schema.Literal("regenerateInvite") }),
  /** Links the environment behind someone's contact link, on both sides. */
  Schema.Struct({ type: Schema.Literal("redeem"), link: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("removeContact"), contactId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("renameContact"),
    contactId: TrimmedNonEmptyString,
    name: PeerName,
  }),
  Schema.Struct({
    type: Schema.Literal("send"),
    contactId: TrimmedNonEmptyString,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(PEER_MESSAGE_TEXT_MAX)),
    replyToId: Schema.optional(TrimmedNonEmptyString),
  }),
  /** Tries a failed message again. */
  Schema.Struct({ type: Schema.Literal("retry"), messageId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("setStatus"),
    messageId: TrimmedNonEmptyString,
    status: Schema.Literals(["unread", "read", "done"]),
  }),
  /** Sends a received message to a thread's agent and marks it done. */
  Schema.Struct({
    type: Schema.Literal("sendToThread"),
    messageId: TrimmedNonEmptyString,
    threadId: ThreadId,
  }),
]);
export type PeersAction = typeof PeersAction.Type;

export class PeersError extends Schema.TaggedError<PeersError>()("PeersError", {
  message: Schema.String,
}) {}

export const WsPeersSubscribeRpc = Rpc.make(PEERS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: PeersSnapshot,
  error: Schema.Union([PeersError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPeersActRpc = Rpc.make(PEERS_WS_METHODS.act, {
  payload: PeersAction,
  success: Schema.Struct({}),
  error: Schema.Union([PeersError, EnvironmentAuthorizationError]),
});

/* Between environments. */

/** `POST ${PEERS_HTTP_PREFIX}/redeem`: the redeeming side introduces itself. */
export const PeerRedeemRequest = Schema.Struct({
  secret: TrimmedNonEmptyString,
  from: Schema.Struct({
    environmentId: TrimmedNonEmptyString,
    name: PeerName,
    baseUrl: Schema.NullOr(TrimmedNonEmptyString),
    /** The token the link's owner sends with its messages to the redeeming side. */
    token: TrimmedNonEmptyString,
  }),
});
export type PeerRedeemRequest = typeof PeerRedeemRequest.Type;

export const PeerRedeemResponse = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  name: PeerName,
  /** The token the redeeming side sends with its messages to the link's owner. */
  token: TrimmedNonEmptyString,
});
export type PeerRedeemResponse = typeof PeerRedeemResponse.Type;

/** `POST ${PEERS_HTTP_PREFIX}/messages` with `Authorization: Bearer <token>`. */
export const PeerDeliverRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: PeerText,
  context: Schema.NullOr(PeerContextText),
  replyToId: Schema.NullOr(TrimmedNonEmptyString),
  sentAt: IsoDateTime,
});
export type PeerDeliverRequest = typeof PeerDeliverRequest.Type;
