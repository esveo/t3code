import {
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  PeerDeliverRequest,
  PeerRedeemRequest,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Peers from "./Peers.ts";

/**
 * Environments in one process, each with its own database, reached through a
 * fake network that calls the other side's service the way its routes would.
 */
const makeNetwork = () => {
  const hosts = new Map<string, Peers.Peers["Service"]>();
  const offline = new Set<string>();
  const decodeRedeem = Schema.decodeUnknownEffect(Schema.fromJsonString(PeerRedeemRequest));
  const decodeDeliver = Schema.decodeUnknownEffect(Schema.fromJsonString(PeerDeliverRequest));

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const peers = hosts.get(url.origin);
      if (!peers || offline.has(url.origin)) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "offline" }),
        });
      }
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const respond = (status: number, json?: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          json === undefined ? new Response(null, { status }) : Response.json(json, { status }),
        );
      if (url.pathname.endsWith("/redeem")) {
        const answer = yield* decodeRedeem(body).pipe(
          Effect.flatMap(peers.acceptRedeem),
          Effect.orDie,
        );
        return Option.isSome(answer) ? respond(200, answer.value) : respond(403);
      }
      const token = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
      const accepted = yield* decodeDeliver(body).pipe(
        Effect.flatMap((message) => peers.receive(token, message)),
        Effect.orDie,
      );
      return accepted ? respond(200, { ok: true }) : respond(401);
    }),
  );

  const environment = (environmentId: string, name: string) =>
    Effect.gen(function* () {
      const baseUrl = `http://${environmentId}.test`;
      const context = yield* Layer.build(
        Layer.mergeAll(
          Layer.fresh(SqlitePersistenceMemory),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      );
      const peers = yield* Peers.makeWith({ environmentId, defaultName: name }).pipe(
        Effect.provideContext(context),
      );
      hosts.set(baseUrl, peers);
      yield* peers.act({ type: "configure", ownBaseUrl: baseUrl });
      return peers;
    });

  return { environment, offline };
};

const inviteLink = (peers: Peers.Peers["Service"]) =>
  Effect.map(peers.snapshot, (snapshot) => {
    assert.isNotNull(snapshot.inviteLink);
    return snapshot.inviteLink!;
  });

describe("Peers", () => {
  it.effect("links two environments from one link and answers into the sending thread", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const anna = yield* network.environment("anna", "Anna");
      const max = yield* network.environment("max", "Max");

      yield* max.act({ type: "redeem", link: yield* inviteLink(anna) });
      assert.deepStrictEqual(
        (yield* anna.listContacts).map((contact) => [contact.id, contact.name, contact.baseUrl]),
        [["max", "Max", "http://max.test"]],
      );
      assert.deepStrictEqual(
        (yield* max.listContacts).map((contact) => [contact.id, contact.name, contact.baseUrl]),
        [["anna", "Anna", "http://anna.test"]],
      );

      const origin = ThreadId.make("thread-auth");
      const { message: question } = yield* anna.send({
        contact: "Max",
        text: "How did you solve the token refresh?",
        context: "Auth refactor in acme/web",
        replyToId: null,
        threadId: origin,
      });
      yield* anna.deliverDue;

      const received = (yield* max.snapshot).messages.find((message) => message.direction === "in");
      assert.strictEqual(received?.id, question.id);
      assert.strictEqual(received?.status, "unread");
      assert.strictEqual(received?.context, "Auth refactor in acme/web");
      assert.strictEqual(received?.threadId, null);
      assert.strictEqual(
        (yield* anna.snapshot).messages.find((message) => message.id === question.id)?.status,
        "delivered",
      );

      // The answer names no contact: it goes to whoever asked.
      yield* max.send({
        contact: null,
        text: "With a refresh mutex.",
        context: "Answer",
        replyToId: question.id,
        threadId: null,
      });
      yield* max.deliverDue;
      const answer = (yield* anna.snapshot).messages.find((message) => message.direction === "in");
      assert.strictEqual(answer?.text, "With a refresh mutex.");
      assert.strictEqual(answer?.threadId, origin);
    }),
  );

  it.effect("makes a contact of itself when it redeems its own link", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const anna = yield* network.environment("anna", "Anna");

      yield* anna.act({ type: "redeem", link: yield* inviteLink(anna) });
      const contacts = yield* anna.listContacts;
      assert.deepStrictEqual(
        contacts.map((contact) => [contact.id, contact.isSelf]),
        [["anna", true]],
      );

      yield* anna.send({
        contact: "anna",
        text: "Note to self",
        context: "Testing",
        replyToId: null,
        threadId: null,
      });
      yield* anna.deliverDue;
      assert.deepStrictEqual(
        (yield* anna.snapshot).messages.map((message) => [message.direction, message.status]),
        [
          ["out", "delivered"],
          ["in", "unread"],
        ],
      );
    }),
  );

  it.effect("keeps a message for an unreachable contact and fails one it rejects", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const anna = yield* network.environment("anna", "Anna");
      const max = yield* network.environment("max", "Max");
      yield* max.act({ type: "redeem", link: yield* inviteLink(anna) });

      network.offline.add("http://max.test");
      yield* anna.send({
        contact: "max",
        text: "Hi",
        context: "c",
        replyToId: null,
        threadId: null,
      });
      yield* anna.deliverDue;
      const waiting = (yield* anna.snapshot).messages[0];
      assert.strictEqual(waiting?.status, "pending");
      assert.include(waiting?.error ?? "", "not reachable");

      // Max drops Anna: her token means nothing there anymore.
      network.offline.clear();
      yield* max.act({ type: "removeContact", contactId: "anna" });
      yield* anna.act({ type: "retry", messageId: waiting!.id });
      yield* anna.send({
        contact: "max",
        text: "Hi again",
        context: "c",
        replyToId: null,
        threadId: null,
      });
      yield* anna.deliverDue;
      const statuses = (yield* anna.snapshot).messages.map((message) => message.status);
      assert.include(statuses, "failed");
    }),
  );

  it.effect("refuses a link whose secret was replaced", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const anna = yield* network.environment("anna", "Anna");
      const max = yield* network.environment("max", "Max");
      const oldLink = yield* inviteLink(anna);
      yield* anna.act({ type: "regenerateInvite" });

      const error = yield* max.act({ type: "redeem", link: oldLink }).pipe(Effect.flip);
      assert.include(error.message, "no longer valid");
      assert.lengthOf(yield* max.listContacts, 0);
    }),
  );

  it.effect("routes an answer on its own into the thread that asked, when routing is on", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const anna = yield* network.environment("anna", "Anna");
      const max = yield* network.environment("max", "Max");
      yield* max.act({ type: "redeem", link: yield* inviteLink(anna) });
      yield* anna.act({ type: "configure", autoRoute: true });

      const origin = ThreadId.make("thread-auth");
      const { message: question } = yield* anna.send({
        contact: "max",
        text: "Question",
        context: "c",
        replyToId: null,
        threadId: origin,
      });
      yield* anna.deliverDue;

      // The routing fiber takes the services of the delivery that started it.
      const commands: Array<OrchestrationCommand> = [];
      const engine = OrchestrationEngine.OrchestrationEngineService.of({
        dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      });
      const shell = {
        id: origin,
        modelSelection: { instanceId: "codex", model: "gpt" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as unknown as OrchestrationThreadShell;
      const snapshots = {
        getThreadShellById: () => Effect.succeed(Option.some(shell)),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

      yield* max.send({
        contact: null,
        text: "The answer",
        context: "c",
        replyToId: question.id,
        threadId: null,
      });
      yield* max.deliverDue.pipe(
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
      );
      const routed = yield* anna.subscribe.pipe(
        Stream.map((snapshot) => snapshot.messages.find((message) => message.direction === "in")),
        Stream.filter((message) => message?.routing != null),
        Stream.runHead,
      );
      const message = Option.getOrThrow(routed);
      assert.strictEqual(message?.status, "done");
      assert.strictEqual(message?.threadId, origin);
      assert.strictEqual(message?.routing?.outcome, "thread");
      const started = commands[0];
      assert.strictEqual(started?.type, "thread.turn.start");
      assert.include(
        started?.type === "thread.turn.start" ? started.message.text : "",
        "**Message from Max**",
      );
    }),
  );
});
