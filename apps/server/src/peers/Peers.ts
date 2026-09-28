/**
 * Fork: peers — contacts with other environments and the messages exchanged
 * with them.
 *
 * Linking: an environment's reusable contact link carries its address and an
 * invite secret. Whoever redeems it introduces itself to the link's owner in
 * one request (`acceptRedeem`), handing over a token for messages back, and
 * gets a token for its own messages in return, so both sides hold the other as
 * a contact. Redeeming one's own link makes a contact of oneself.
 *
 * Sending: a message goes into the outbox and a worker posts it to the
 * contact's address (`receive` on the other side). Unreachable contacts are
 * retried with backoff for a day; a rejected token or a missing route fails
 * the message right away, since only linking again repairs that.
 *
 * Everything lives in fork tables (see `forkSchema.ts`); each change tells the
 * open subscriptions, which get the whole snapshot again.
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  PEERS_HTTP_PREFIX,
  type PeerAdoptMode,
  type PeerContact,
  type PeerDeliverRequest,
  type PeerMessage,
  PeerRedeemResponse,
  PeerRouting,
  type PeerRedeemRequest,
  type PeersAction,
  PeersError,
  type PeersSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildPeerInviteLink,
  formatPeerMessageForThread,
  parsePeerInviteLink,
} from "@t3tools/shared/peers";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { announceToolListChanged } from "../mcp/McpOrchestrationTools.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import { decideRoute } from "./PeersRouting.ts";

/** How many messages a snapshot carries; the channel shows the latest. */
const SNAPSHOT_MESSAGE_LIMIT = 300;
const DELIVERY_TIMEOUT = "15 seconds";
const GIVE_UP_AFTER_MS = Duration.toMillis(Duration.hours(24));
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = Duration.toMillis(Duration.minutes(10));
const SWEEP_INTERVAL = "30 seconds";

/** How long a message waits after its n-th failed delivery (n ≥ 1). */
export function peerRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/** Why a contact refused a message for good, or null when trying again may help. */
export function permanentDeliveryFailure(status: number): string | null {
  if (status === 401 || status === 403) {
    return "The contact no longer knows this environment. Link again with their contact link.";
  }
  if (status === 404 || status === 405 || status === 410) {
    return "The contact's address does not take messages (anymore). Link again with their current contact link.";
  }
  if (status === 413) return "The message is too large for the contact.";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return `The contact rejected the message (HTTP ${status}).`;
  }
  return null;
}

// Whether any contact exists; the MCP tools read it synchronously.
let contactsLinked = false;
export const peersToolsOn = (): boolean => contactsLinked;

export class Peers extends Context.Service<
  Peers,
  {
    readonly snapshot: Effect.Effect<PeersSnapshot, PeersError>;
    readonly subscribe: Stream.Stream<PeersSnapshot, PeersError>;
    readonly act: (action: PeersAction) => Effect.Effect<void, PeersError>;
    readonly listContacts: Effect.Effect<ReadonlyArray<PeerContact>, PeersError>;
    /** An agent's message; `contact` is an id or name, optional when it answers a message. */
    readonly send: (input: {
      readonly contact: string | null;
      readonly text: string;
      readonly context: string | null;
      readonly replyToId: string | null;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<
      { readonly message: PeerMessage; readonly contact: PeerContact },
      PeersError
    >;
    /** The link owner's side of redeeming; None when the secret does not match. */
    readonly acceptRedeem: (
      request: PeerRedeemRequest,
    ) => Effect.Effect<Option.Option<PeerRedeemResponse>, PeersError>;
    /** A contact delivers a message; false when the token belongs to no contact. */
    readonly receive: (
      token: string,
      request: PeerDeliverRequest,
    ) => Effect.Effect<boolean, PeersError>;
    /** Posts every due outbox message once; the worker runs it on its own. */
    readonly deliverDue: Effect.Effect<void>;
  }
>()("t3/peers/Peers") {}

interface ContactRow {
  readonly id: string;
  readonly name: string;
  readonly base_url: string | null;
  readonly outbound_token: string;
  readonly inbound_token_hash: string;
  readonly is_self: number;
  readonly created_at: string;
}

interface MessageRow {
  readonly id: string;
  readonly direction: string;
  readonly contact_id: string;
  readonly text: string;
  readonly context: string | null;
  readonly reply_to_id: string | null;
  readonly thread_id: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly attempts: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly routing_json: string | null;
}

const toContact = (row: ContactRow): PeerContact => ({
  id: row.id,
  name: row.name,
  baseUrl: row.base_url,
  isSelf: row.is_self === 1,
  createdAt: row.created_at,
});

const toMessage = (row: MessageRow): PeerMessage => ({
  id: row.id,
  contactId: row.contact_id,
  direction: row.direction === "in" ? "in" : "out",
  text: row.text,
  context: row.context,
  replyToId: row.reply_to_id,
  threadId: row.thread_id as ThreadId | null,
  status: row.status as PeerMessage["status"],
  error: row.error,
  routing: row.routing_json ? Option.getOrNull(decodeRouting(row.routing_json)) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeRouting = Schema.decodeUnknownOption(Schema.fromJsonString(PeerRouting));
const encodeRouting = Schema.encodeEffect(Schema.fromJsonString(PeerRouting));

const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const newSecret = () => NodeCrypto.randomBytes(32).toString("base64url");
const secretsEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const failure = (message: string) => new PeersError({ message });

export interface PeersIdentity {
  readonly environmentId: string;
  /** The name contacts see until the user sets one. */
  readonly defaultName: string;
}

export const makeWith = Effect.fn("Peers.make")(function* (self: PeersIdentity) {
  const sql = yield* SqlClient.SqlClient;
  const httpClient = yield* HttpClient.HttpClient;
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );
  const wake = yield* Effect.acquireRelease(PubSub.unbounded<void>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );
  const deliveries = yield* Semaphore.make(1);
  const layerScope = yield* Scope.Scope;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const storeFailed = (detail: string) => () => failure(`Could not ${detail}.`);
  const uuid = Effect.sync(() => NodeCrypto.randomUUID());

  /* Settings. */

  const readSetting = (key: string) =>
    sql<{ readonly value: string }>`SELECT value FROM fork_peer_settings WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
      Effect.mapError(storeFailed("read the peer settings")),
    );
  const writeSetting = (key: string, value: string | null) =>
    (value === null
      ? sql`DELETE FROM fork_peer_settings WHERE key = ${key}`
      : sql`
          INSERT INTO fork_peer_settings (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value
        `
    ).pipe(Effect.asVoid, Effect.mapError(storeFailed("save the peer settings")));

  const ownName = Effect.map(readSetting("own_name"), (name) => name ?? self.defaultName);
  const ownBaseUrl = readSetting("own_base_url");
  const adoptMode = Effect.map(readSetting("adopt_mode"), (mode): PeerAdoptMode =>
    mode === "send" ? "send" : "composer",
  );
  const autoRoute = Effect.map(readSetting("auto_route"), (value) => value === "on");
  const inviteSecret = Effect.gen(function* () {
    const existing = yield* readSetting("invite_secret");
    if (existing) return existing;
    const secret = newSecret();
    yield* writeSetting("invite_secret", secret);
    return secret;
  });

  /* Contacts. */

  const contactRows = sql<ContactRow>`
    SELECT * FROM fork_peer_contacts ORDER BY is_self DESC, name COLLATE NOCASE
  `.pipe(Effect.mapError(storeFailed("read the contacts")));

  const findContact = (id: string) =>
    sql<ContactRow>`SELECT * FROM fork_peer_contacts WHERE id = ${id}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(storeFailed("read the contacts")),
    );

  /** Tells MCP sessions when the peer tools appear or disappear. */
  const refreshToolsFlag = Effect.gen(function* () {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM fork_peer_contacts
    `.pipe(Effect.orElseSucceed(() => [{ count: 0 }]));
    const linked = (rows[0]?.count ?? 0) > 0;
    if (linked !== contactsLinked) {
      contactsLinked = linked;
      announceToolListChanged();
    }
  });

  const changed = Effect.andThen(refreshToolsFlag, PubSub.publish(changes, undefined));

  /**
   * Creates or relinks a contact. A relink keeps the name the user may have
   * given it; the tokens and address are the new ones.
   */
  const upsertContact = (input: {
    readonly id: string;
    readonly name: string;
    readonly baseUrl: string | null;
    readonly outboundToken: string;
    readonly inboundTokenHash: string;
    readonly isSelf: boolean;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO fork_peer_contacts
          (id, name, base_url, outbound_token, inbound_token_hash, is_self, created_at)
        VALUES (${input.id}, ${input.name}, ${input.baseUrl}, ${input.outboundToken},
          ${input.inboundTokenHash}, ${input.isSelf ? 1 : 0}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          base_url = excluded.base_url,
          outbound_token = excluded.outbound_token,
          inbound_token_hash = excluded.inbound_token_hash,
          is_self = excluded.is_self
      `.pipe(Effect.mapError(storeFailed("save the contact")));
      yield* changed;
    });

  /* Messages. */

  const findMessage = (id: string, direction: "in" | "out") =>
    sql<MessageRow>`
      SELECT * FROM fork_peer_messages WHERE id = ${id} AND direction = ${direction}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(storeFailed("read the messages")),
    );

  const setMessageStatus = (
    id: string,
    direction: "in" | "out",
    status: PeerMessage["status"],
    error: string | null = null,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        UPDATE fork_peer_messages SET status = ${status}, error = ${error}, updated_at = ${now}
        WHERE id = ${id} AND direction = ${direction}
      `.pipe(Effect.mapError(storeFailed("update the message")));
      yield* changed;
    });

  /** The model routing asks, as Settings → General names it; null when unknown here. */
  const routingModelLabel = Effect.gen(function* () {
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    if (Option.isNone(settings)) return null;
    const current = yield* settings.value.getSettings.pipe(Effect.option);
    return Option.isSome(current)
      ? `${current.value.textGenerationModelSelection.instanceId} · ${current.value.textGenerationModelSelection.model}`
      : null;
  });

  const snapshot: Peers["Service"]["snapshot"] = Effect.gen(function* () {
    const contacts = yield* contactRows;
    const messages = yield* sql<MessageRow>`
      SELECT * FROM (
        SELECT * FROM fork_peer_messages ORDER BY created_at DESC, direction LIMIT ${SNAPSHOT_MESSAGE_LIMIT}
      ) ORDER BY created_at, direction DESC
    `.pipe(Effect.mapError(storeFailed("read the messages")));
    const baseUrl = yield* ownBaseUrl;
    return {
      environmentId: self.environmentId,
      ownName: yield* ownName,
      ownBaseUrl: baseUrl,
      inviteLink: baseUrl ? buildPeerInviteLink(baseUrl, yield* inviteSecret) : null,
      adoptMode: yield* adoptMode,
      autoRoute: yield* autoRoute,
      routingModel: yield* routingModelLabel,
      contacts: contacts.map(toContact),
      messages: messages.map(toMessage),
    };
  });

  const resolveContact = (reference: string) =>
    Effect.gen(function* () {
      const contacts = (yield* contactRows).map(toContact);
      const byId = contacts.find((contact) => contact.id === reference);
      if (byId) return byId;
      const needle = reference.trim().toLowerCase();
      const byName = contacts.filter((contact) => contact.name.toLowerCase() === needle);
      if (byName.length === 1) return byName[0]!;
      const known = contacts.map((contact) => `${contact.name} (${contact.id})`).join(", ");
      return yield* failure(
        byName.length > 1
          ? `Several contacts are called ${reference}; pass the id instead. Contacts: ${known}.`
          : `No contact ${reference}. Contacts: ${known || "none"}.`,
      );
    });

  const enqueue: Peers["Service"]["send"] = (input) =>
    Effect.gen(function* () {
      const answered = input.replyToId ? yield* findMessage(input.replyToId, "in") : Option.none();
      if (input.replyToId && Option.isNone(answered)) {
        return yield* failure(`No received message ${input.replyToId} to answer.`);
      }
      const contactReference =
        input.contact ?? (Option.isSome(answered) ? answered.value.contact_id : null);
      if (!contactReference) return yield* failure("Name the contact to send the message to.");
      const contact = yield* resolveContact(contactReference);
      if (Option.isSome(answered) && answered.value.contact_id !== contact.id) {
        return yield* failure(`Message ${input.replyToId} came from another contact.`);
      }
      const id = yield* uuid;
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO fork_peer_messages
          (id, direction, contact_id, text, context, reply_to_id, thread_id, status, attempts,
           next_attempt_at, created_at, updated_at)
        VALUES (${id}, 'out', ${contact.id}, ${input.text}, ${input.context}, ${input.replyToId},
          ${input.threadId}, 'pending', 0, ${now}, ${now}, ${now})
      `.pipe(Effect.mapError(storeFailed("queue the message")));
      yield* changed;
      yield* PubSub.publish(wake, undefined);
      const message = yield* findMessage(id, "out").pipe(
        Effect.flatMap((row) =>
          Option.isSome(row)
            ? Effect.succeed(toMessage(row.value))
            : Effect.fail(failure("Lost the message.")),
        ),
      );
      return { message, contact };
    });

  /* Delivery. */

  const post = (url: string, token: string | null, body: unknown) =>
    httpClient
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
          token ? HttpClientRequest.bearerToken(token) : identity,
        ),
      )
      .pipe(Effect.timeout(DELIVERY_TIMEOUT));

  const deliverOne = (row: MessageRow) =>
    Effect.gen(function* () {
      const contact = yield* findContact(row.contact_id);
      if (Option.isNone(contact)) {
        return yield* setMessageStatus(row.id, "out", "failed", "The contact was removed.");
      }
      if (!contact.value.base_url) {
        return yield* setMessageStatus(
          row.id,
          "out",
          "failed",
          "This contact gave no address to reach it. Ask them for their contact link and link again.",
        );
      }
      const body: PeerDeliverRequest = {
        id: row.id,
        text: row.text,
        context: row.context,
        replyToId: row.reply_to_id,
        sentAt: row.created_at,
      };
      const outcome = yield* post(
        `${contact.value.base_url}${PEERS_HTTP_PREFIX}/messages`,
        contact.value.outbound_token,
        body,
      ).pipe(
        Effect.map((response) => response.status),
        Effect.result,
      );
      const status = outcome._tag === "Success" ? outcome.success : null;
      if (status !== null && status >= 200 && status < 300) {
        return yield* setMessageStatus(row.id, "out", "delivered");
      }
      const permanent = status === null ? null : permanentDeliveryFailure(status);
      if (permanent) return yield* setMessageStatus(row.id, "out", "failed", permanent);
      const reason =
        status === null
          ? "The contact is not reachable right now; trying again."
          : `The contact answered HTTP ${status}; trying again.`;
      const now = yield* DateTime.now;
      const age = DateTime.toEpochMillis(now) - Date.parse(row.created_at);
      if (age >= GIVE_UP_AFTER_MS) {
        return yield* setMessageStatus(
          row.id,
          "out",
          "failed",
          "The contact was not reachable for a day. Try again once it is online.",
        );
      }
      const attempts = row.attempts + 1;
      const nextAttemptAt = DateTime.formatIso(
        DateTime.add(now, { milliseconds: peerRetryDelayMs(attempts) }),
      );
      yield* sql`
        UPDATE fork_peer_messages
        SET attempts = ${attempts}, next_attempt_at = ${nextAttemptAt}, error = ${reason},
          updated_at = ${DateTime.formatIso(now)}
        WHERE id = ${row.id} AND direction = 'out'
      `.pipe(Effect.mapError(storeFailed("update the message")));
      yield* changed;
    });

  const deliverDue: Peers["Service"]["deliverDue"] = deliveries.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* nowIso;
      const due = yield* sql<MessageRow>`
        SELECT * FROM fork_peer_messages
        WHERE direction = 'out' AND status = 'pending' AND next_attempt_at <= ${now}
        ORDER BY created_at
      `.pipe(Effect.mapError(storeFailed("read the outbox")));
      yield* Effect.forEach(due, deliverOne, { discard: true });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("peers: outbox delivery failed", cause)),
    ),
  );

  /* Linking. */

  const redeem = (link: string) =>
    Effect.gen(function* () {
      const parsed = parsePeerInviteLink(link);
      if (!parsed) {
        return yield* failure(
          "That is not a contact link. It looks like https://…/api/fork/peers/invite#….",
        );
      }
      const token = newSecret();
      const request: PeerRedeemRequest = {
        secret: parsed.secret,
        from: {
          environmentId: self.environmentId,
          name: yield* ownName,
          baseUrl: yield* ownBaseUrl,
          token,
        },
      };
      const response = yield* post(
        `${parsed.baseUrl}${PEERS_HTTP_PREFIX}/redeem`,
        null,
        request,
      ).pipe(
        Effect.mapError(() =>
          failure(`Could not reach ${parsed.baseUrl}. Is that environment running and reachable?`),
        ),
      );
      if (response.status === 403 || response.status === 404) {
        return yield* failure(
          response.status === 404
            ? "That environment does not take contacts. It may run a T3 Code without Peers."
            : "The contact link is no longer valid. Ask for the current one.",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* failure(`Linking failed (HTTP ${response.status}).`);
      }
      const answer = yield* HttpClientResponse.schemaBodyJson(PeerRedeemResponse)(response).pipe(
        Effect.mapError(() => failure("The other environment answered in an unexpected way.")),
      );
      const isSelf = answer.environmentId === self.environmentId;
      yield* upsertContact({
        id: answer.environmentId,
        name: answer.name,
        baseUrl: parsed.baseUrl,
        outboundToken: answer.token,
        inboundTokenHash: hashToken(token),
        isSelf,
      });
    });

  const acceptRedeem: Peers["Service"]["acceptRedeem"] = (request) =>
    Effect.gen(function* () {
      const secret = yield* readSetting("invite_secret");
      if (!secret || !secretsEqual(secret, request.secret)) return Option.none();
      const name = yield* ownName;
      if (request.from.environmentId === self.environmentId) {
        // Linking oneself: one contact, one token both ways.
        yield* upsertContact({
          id: self.environmentId,
          name,
          baseUrl: request.from.baseUrl,
          outboundToken: request.from.token,
          inboundTokenHash: hashToken(request.from.token),
          isSelf: true,
        });
        return Option.some({ environmentId: self.environmentId, name, token: request.from.token });
      }
      const token = newSecret();
      yield* upsertContact({
        id: request.from.environmentId,
        name: request.from.name,
        baseUrl: request.from.baseUrl,
        outboundToken: request.from.token,
        inboundTokenHash: hashToken(token),
        isSelf: false,
      });
      return Option.some({ environmentId: self.environmentId, name, token });
    });

  const receive: Peers["Service"]["receive"] = (token, request) =>
    Effect.gen(function* () {
      const contact = yield* sql<ContactRow>`
        SELECT * FROM fork_peer_contacts WHERE inbound_token_hash = ${hashToken(token)}
      `.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError(storeFailed("read the contacts")),
      );
      if (!contact) return false;
      // An answer to a message a thread sent is shown in that thread.
      const answered = request.replyToId
        ? yield* findMessage(request.replyToId, "out")
        : Option.none<MessageRow>();
      const threadId =
        Option.isSome(answered) && answered.value.contact_id === contact.id
          ? answered.value.thread_id
          : null;
      const now = yield* nowIso;
      const inserted = yield* sql<{ readonly id: string }>`
        INSERT INTO fork_peer_messages
          (id, direction, contact_id, text, context, reply_to_id, thread_id, status, attempts,
           created_at, updated_at)
        VALUES (${request.id}, 'in', ${contact.id}, ${request.text}, ${request.context},
          ${request.replyToId}, ${threadId}, 'unread', 0, ${now}, ${now})
        ON CONFLICT (id, direction) DO NOTHING
        RETURNING id
      `.pipe(Effect.mapError(storeFailed("store the message")));
      yield* changed;
      // Routing runs beside the request: the sender only waits for the delivery.
      if (inserted.length > 0 && (yield* autoRoute)) {
        yield* routeIncoming(request.id).pipe(Effect.forkIn(layerScope));
      }
      return true;
    });

  /* The user's side. */

  /**
   * Starts a turn on the thread with the message, as if the user had sent it,
   * and marks the message done in that thread.
   */
  const forwardToThread = (message: MessageRow, threadId: ThreadId) =>
    Effect.gen(function* () {
      const contact = yield* findContact(message.contact_id);
      const senderName = Option.isSome(contact) ? contact.value.name : "a removed contact";
      const engine = yield* Effect.serviceOption(OrchestrationEngine.OrchestrationEngineService);
      const snapshots = yield* Effect.serviceOption(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      );
      if (Option.isNone(engine) || Option.isNone(snapshots)) {
        return yield* failure("This server cannot start turns.");
      }
      const thread = yield* snapshots.value.getThreadShellById(threadId).pipe(
        Effect.mapError(storeFailed("read the thread")),
        Effect.flatMap((shell) =>
          Option.isSome(shell)
            ? Effect.succeed(shell.value)
            : Effect.fail(failure("The thread was not found.")),
        ),
      );
      yield* engine.value
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:peers-send:${yield* uuid}`),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: formatPeerMessageForThread(toMessage(message), senderName),
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(() => failure("Could not send the message to the thread.")));
      const now = yield* nowIso;
      yield* sql`
        UPDATE fork_peer_messages SET status = 'done', thread_id = ${thread.id}, updated_at = ${now}
        WHERE id = ${message.id} AND direction = 'in'
      `.pipe(Effect.mapError(storeFailed("update the message")));
      yield* changed;
    });

  const sendToThread = (messageId: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const message = yield* findMessage(messageId, "in");
      if (Option.isNone(message)) return yield* failure("The message was not found.");
      yield* forwardToThread(message.value, threadId);
    });

  const saveRouting = (messageId: string, routing: PeerRouting) =>
    Effect.gen(function* () {
      const routingJson = yield* encodeRouting(routing).pipe(
        Effect.mapError(storeFailed("record the routing")),
      );
      yield* sql`
        UPDATE fork_peer_messages SET routing_json = ${routingJson}
        WHERE id = ${messageId} AND direction = 'in'
      `.pipe(Effect.mapError(storeFailed("record the routing")));
      yield* changed;
    });

  /**
   * Automatic routing: an answer goes back to the thread that asked, anything
   * else to the thread the model picks. What was decided is kept with the
   * message, so the channel can show why it went where it went.
   */
  const routeIncoming = (messageId: string) =>
    Effect.gen(function* () {
      const found = yield* findMessage(messageId, "in");
      if (Option.isNone(found)) return;
      const message = found.value;
      const contact = yield* findContact(message.contact_id);
      const senderName = Option.isSome(contact) ? contact.value.name : "a removed contact";
      const routing: PeerRouting = message.thread_id
        ? {
            decidedAt: yield* nowIso,
            outcome: "thread",
            threadId: message.thread_id as ThreadId,
            threadTitle: null,
            model: null,
            steps: [],
            reason: "It answers a message this thread sent.",
            candidates: [],
          }
        : yield* decideRoute({ senderName, text: message.text, context: message.context });
      if (routing.outcome === "thread" && routing.threadId) {
        const forwarded = yield* forwardToThread(message, routing.threadId).pipe(Effect.result);
        if (forwarded._tag === "Failure") {
          return yield* saveRouting(messageId, {
            ...routing,
            outcome: "stay",
            reason: `${routing.reason} Forwarding failed: ${forwarded.failure.message}`,
          });
        }
      }
      yield* saveRouting(messageId, routing);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("peers: routing failed", cause)));

  const act: Peers["Service"]["act"] = (action) => {
    switch (action.type) {
      case "configure":
        return Effect.gen(function* () {
          if (action.ownName !== undefined) yield* writeSetting("own_name", action.ownName);
          if (action.ownBaseUrl !== undefined) {
            yield* writeSetting("own_base_url", action.ownBaseUrl);
          }
          if (action.adoptMode !== undefined) yield* writeSetting("adopt_mode", action.adoptMode);
          if (action.autoRoute !== undefined) {
            yield* writeSetting("auto_route", action.autoRoute ? "on" : "off");
          }
          yield* changed;
        });
      case "regenerateInvite":
        return Effect.andThen(writeSetting("invite_secret", newSecret()), changed);
      case "redeem":
        return redeem(action.link);
      case "removeContact":
        return Effect.gen(function* () {
          yield* sql`DELETE FROM fork_peer_messages WHERE contact_id = ${action.contactId}`.pipe(
            Effect.andThen(sql`DELETE FROM fork_peer_contacts WHERE id = ${action.contactId}`),
            sql.withTransaction,
            Effect.mapError(storeFailed("remove the contact")),
          );
          yield* changed;
        });
      case "renameContact":
        return Effect.gen(function* () {
          yield* sql`
            UPDATE fork_peer_contacts SET name = ${action.name} WHERE id = ${action.contactId}
          `.pipe(Effect.mapError(storeFailed("rename the contact")));
          yield* changed;
        });
      case "send":
        return enqueue({
          contact: action.contactId,
          text: action.text,
          context: null,
          replyToId: action.replyToId ?? null,
          threadId: null,
        }).pipe(Effect.asVoid);
      case "retry":
        return Effect.gen(function* () {
          const now = yield* nowIso;
          yield* sql`
            UPDATE fork_peer_messages
            SET status = 'pending', error = NULL, attempts = 0, next_attempt_at = ${now},
              created_at = ${now}, updated_at = ${now}
            WHERE id = ${action.messageId} AND direction = 'out' AND status = 'failed'
          `.pipe(Effect.mapError(storeFailed("retry the message")));
          yield* changed;
          yield* PubSub.publish(wake, undefined);
        });
      case "setStatus":
        return setMessageStatus(action.messageId, "in", action.status);
      case "sendToThread":
        return sendToThread(action.messageId, action.threadId);
    }
  };

  const subscribe: Peers["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(snapshot),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
      );
    }),
  );

  yield* refreshToolsFlag;
  yield* Effect.addFinalizer(() => Effect.sync(() => (contactsLinked = false)));
  // The outbox worker: right after a send, and every half minute for retries.
  yield* Stream.merge(Stream.fromPubSub(wake), Stream.tick(SWEEP_INTERVAL)).pipe(
    Stream.runForEach(() => deliverDue),
    Effect.forkScoped,
  );

  return Peers.of({
    snapshot,
    subscribe,
    act,
    listContacts: Effect.map(contactRows, (rows) => rows.map(toContact)),
    send: enqueue,
    acceptRedeem,
    receive,
    deliverDue,
  });
});

export const layer = Layer.effect(
  Peers,
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    return yield* makeWith({
      environmentId: descriptor.environmentId,
      defaultName: descriptor.label,
    });
  }),
);

/** The RPC, HTTP and MCP sides read the service optionally, like the decisions do. */
export const withService = <A>(use: (peers: Peers["Service"]) => Effect.Effect<A, PeersError>) =>
  Effect.flatMap(Effect.serviceOption(Peers), (peers) =>
    Option.isSome(peers)
      ? use(peers.value)
      : Effect.fail(failure("This server does not keep contacts.")),
  );

export const subscribeRpc = () =>
  Stream.unwrap(withService((peers) => Effect.succeed(peers.subscribe)));

export const actRpc = (action: PeersAction) =>
  withService((peers) => peers.act(action)).pipe(Effect.as({}));
