// @effect-diagnostics nodeBuiltinImport:off - fixtures load synchronously at module scope.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ServerSettings,
  ThreadId,
  type VoiceCallEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  ThreadManagementService,
  type ThreadManagementSendInput,
} from "../orchestration-v2/ThreadManagementService.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RealtimeCallClient } from "./RealtimeCallClient.ts";
import {
  decodeRealtimeEvent,
  type RealtimeEvent,
  type RealtimeOutbound,
} from "./realtimeEvents.ts";
import { noTargetAnswer } from "./voiceCallPrompt.ts";
import * as VoiceCallReadBack from "./VoiceCallReadBack.ts";
import * as VoiceCall from "./VoiceCallService.ts";

const fixture = (name: string): ReadonlyArray<RealtimeEvent> =>
  NodeFS.readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => Option.toArray(decodeRealtimeEvent(JSON.parse(line))));

const TARGET = ThreadId.make("thread-alpha");
const ARCHIVED = ThreadId.make("thread-archived");
const shell = (id: ThreadId, archived: boolean) =>
  ({
    id,
    title: id === TARGET ? "Alpha" : "Old work",
    projectId: ProjectId.make("project-1"),
    archivedAt: archived ? DateTime.makeUnsafe(0) : null,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;

const fakeJwt = (expSeconds: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.sig`;

const ANSWER = "All **128** tests pass.\n\n```ts\nexpect(1).toBe(1);\n```";

const settledRun = (status: "completed" | "failed") =>
  ({
    type: "run.updated",
    threadId: TARGET,
    payload: { id: "run-1", threadId: TARGET, status },
  }) as unknown as OrchestrationV2DomainEvent;

/**
 * A realtime session the test feeds events into and reads sent events from,
 * and a thread whose run `run-1` answers with `ANSWER`. The SQL database
 * comes from outside, so a test can build the services twice on it.
 */
const makeHarness = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<RealtimeEvent, Cause.Done>();
  const outbound = yield* Queue.unbounded<RealtimeOutbound | "closed">();
  const sent: Array<ThreadManagementSendInput> = [];
  let calls = 0;
  const realtime = Layer.succeed(RealtimeCallClient)({
    createCall: () =>
      Effect.sync(() => ({ answerSdp: "v=0 answer", realtimeCallId: `rtc_${++calls}` })),
    openSideband: () =>
      Effect.acquireRelease(
        Effect.succeed({
          events: Stream.fromQueue(inbound),
          send: (event: RealtimeOutbound) => Queue.offer(outbound, event).pipe(Effect.asVoid),
        }),
        () => Queue.offer(outbound, "closed"),
      ),
  });
  const management = Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        threadId === TARGET
          ? shell(TARGET, false)
          : threadId === ARCHIVED
            ? shell(ARCHIVED, true)
            : null,
      ),
    sendToThread: (input) =>
      Effect.sync(() => void sent.push(input)).pipe(
        Effect.as({ message: { id: input.messageId }, run: { id: "run-1" } } as never),
      ),
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexHome = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: fakeJwt(4_000_000_000), account_id: "account-1" },
    }),
  );
  const settings = ServerSettingsService.layerTest({
    enableVoiceCall: true,
    providerInstances: { codex: { driver: "codex", config: { homePath: codexHome } } },
  } as Partial<ServerSettings> as never);
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadRecords: ((_threadId: ThreadId, fields: ReadonlyArray<string>) =>
      Effect.succeed(
        fields.includes("runs")
          ? { runs: [{ id: "run-1", threadId: TARGET, status: "completed" }] }
          : { messages: [{ role: "assistant", text: ANSWER }] },
      )) as never,
  });
  const engine = Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never });
  const layer = VoiceCallReadBack.layer.pipe(
    Layer.provideMerge(VoiceCall.layer),
    Layer.provide(
      Layer.mergeAll(realtime, management, settings, projections, engine, NodeServices.layer),
    ),
  );
  return { inbound, outbound, sent, layer };
});

/** Subscribes as `clientId` and waits for the snapshot, so the server counts the subscription. */
const subscribeAs = (clientId: string) =>
  Effect.gen(function* () {
    const service = yield* VoiceCall.VoiceCallService;
    const events = yield* Queue.unbounded<VoiceCallEvent>();
    const fiber = yield* service.subscribe(clientId).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const snapshot = yield* Queue.take(events);
    assert.equal(snapshot.type, "snapshot");
    return { events, fiber };
  });

const nextOf = <T extends VoiceCallEvent["type"]>(
  events: Queue.Queue<VoiceCallEvent>,
  type: T,
): Effect.Effect<Extract<VoiceCallEvent, { readonly type: T }>> =>
  Effect.flatMap(Queue.take(events), (event) =>
    event.type === type
      ? Effect.succeed(event as Extract<VoiceCallEvent, { readonly type: T }>)
      : nextOf(events, type),
  );

/** Waits until the call has processed `event`, using a voice transcript as the marker. */
const processed = (
  harness: { readonly inbound: Queue.Queue<RealtimeEvent, Cause.Done> },
  events: Queue.Queue<VoiceCallEvent>,
  marker: string,
) =>
  Effect.gen(function* () {
    yield* Queue.offerAll(harness.inbound, [
      { type: "turn.created", turnId: marker, speaker: "voice", text: "" },
      { type: "turn.done", turnId: marker, speaker: "voice", text: marker },
    ]);
    const untilMarker: Effect.Effect<void> = Effect.flatMap(
      nextOf(events, "transcript"),
      (event) => (event.done && event.text === marker ? Effect.void : untilMarker),
    );
    yield* untilMarker;
  });

const spokenText = (event: RealtimeOutbound | "closed") =>
  event === "closed" ? "closed" : JSON.stringify(event);

const callStates = (events: Queue.Queue<VoiceCallEvent>) =>
  Effect.map(Queue.takeAll(events), (taken) =>
    taken.flatMap((event) => (event.type === "call" && event.call ? [event.call.state] : [])),
  );

describe("VoiceCallService", () => {
  it.effect("steers the thread on screen once per delegation, marked as voice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        const result = yield* service.connect({
          clientId: "tab-1",
          offerSdp: "v=0 offer",
          target: TARGET,
        });
        assert.equal(result.answerSdp, "v=0 answer");
        assert.equal(result.segmentId, "rtc_1");

        const events = fixture("a1_v3_dc").filter((event) => event.type !== "session.closed");
        const delegation = events.find((event) => event.type === "delegation.created");
        assert.isDefined(delegation);
        // A redelivered event must not steer twice.
        yield* Queue.offerAll(harness.inbound, [...events, delegation!]);
        const pushed = yield* nextOf(client.events, "delegation");
        assert.equal(pushed.delegation.status, "open");

        assert.equal(harness.sent.length, 1);
        const message = harness.sent[0]!;
        assert.equal(message.threadId, TARGET);
        assert.equal(message.mode, "auto");
        assert.equal(message.commandId, `voice-call:${result.callId}:item_Eblngey9L7Mxg91SDSMZ6`);
        assert.match(message.text, /^\[Voice\]\(t3-context:\/\/v1\/voice-call\/voice-item_/);
        assert.include(message.text, "run the unit tests");
        assert.equal(message.context?.records[0]?.kind, VoiceCall.VOICE_CALL_CONTEXT_KIND);

        const [recorded] = yield* service.delegations;
        assert.equal(recorded?.status, "open");
        assert.equal(recorded?.runId, "run-1");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("answers at once when no thread or an archived one is on screen", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: null });
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_one",
          text: "Run the tests",
        });
        const first = yield* Queue.take(harness.outbound);
        assert.deepEqual(first, {
          type: "delegation.context.append",
          delegation_item_id: "item_one",
          channel: "speakable",
          content: [{ type: "input_text", text: noTargetAnswer }],
        });

        yield* service.setTarget(ARCHIVED);
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_two",
          text: "Run the tests",
        });
        const second = yield* Queue.take(harness.outbound);
        assert.include(JSON.stringify(second), "archived");
        assert.equal(harness.sent.length, 0);
        const statuses = (yield* service.delegations).map((delegation) => delegation.status);
        assert.deepEqual(statuses, ["failed", "failed"]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("closes the session when the owning client goes away", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const watcher = yield* subscribeAs("tab-2");
        const owner = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Fiber.interrupt(owner.fiber);
        assert.equal(yield* Queue.take(harness.outbound), "closed");
        const states = yield* callStates(watcher.events);
        assert.deepEqual(states, ["connecting", "live", "error"]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("refuses to connect a client that does not watch the call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const exit = yield* service
          .connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET })
          .pipe(Effect.exit);
        assert.isTrue(exit._tag === "Failure");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );
  it.effect("answers the newest delegation of a settled run and supersedes the older", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        for (const itemId of ["item_one", "item_two"]) {
          yield* Queue.offer(harness.inbound, { type: "delegation.created", itemId, text: itemId });
          yield* nextOf(client.events, "delegation");
          yield* TestClock.adjust("1 second");
        }
        yield* readBack.handle(settledRun("completed"));
        const answer = yield* Queue.take(harness.outbound);
        assert.deepEqual(answer, {
          type: "delegation.context.append",
          delegation_item_id: "item_two",
          channel: "speakable",
          content: [
            {
              type: "input_text",
              text: "From Alpha: All 128 tests pass. (The code is in the thread.)",
            },
          ],
        });
        const statuses = Object.fromEntries(
          (yield* service.delegations).map((delegation) => [delegation.id, delegation.status]),
        );
        assert.deepEqual(statuses, { item_one: "superseded", item_two: "answered" });

        // `run.updated` repeats after a run settles; the answered run is not
        // read again as an unprompted update.
        yield* readBack.handle(settledRun("completed"));
        yield* processed(harness, client.events, "marker");
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("reads back an undelegated run of the thread on screen once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        yield* subscribeAs("tab-1");
        yield* readBack.handle(settledRun("completed"));
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* readBack.handle(settledRun("failed"));
        yield* readBack.handle(settledRun("failed"));
        assert.include(
          spokenText(yield* Queue.take(harness.outbound)),
          "Update from Alpha: The run failed.",
        );
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("holds an injection until no turn is open and the user is quiet", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: null });
        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "user-1", speaker: "user", text: "Run" },
          { type: "delegation.created", itemId: "item_one", text: "Run the tests" },
        ]);
        yield* processed(harness, client.events, "filler");
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)), "user turn open");

        yield* Queue.offer(harness.inbound, {
          type: "turn.done",
          turnId: "user-1",
          speaker: "user",
          text: "Run the tests",
        });
        yield* processed(harness, client.events, "filler-2");
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)), "user just spoke");

        yield* TestClock.adjust("1 second");
        assert.include(spokenText(yield* Queue.take(harness.outbound)), noTargetAnswer);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("answers a delegation of a closed segment as an unprompted result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_one",
          text: "Run the tests",
        });
        yield* nextOf(client.events, "delegation");
        yield* service.connect({
          clientId: "tab-1",
          offerSdp: "v=0 offer",
          target: TARGET,
          retryOf: "rtc_1",
        });
        assert.equal(yield* Queue.take(harness.outbound), "closed");
        yield* readBack.handle(settledRun("completed"));
        const answer = spokenText(yield* Queue.take(harness.outbound));
        assert.include(answer, "session.context.append");
        assert.include(answer, 'Result of the earlier request \\"Run the tests\\". From Alpha:');
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("answers a delegation whose run settled while the server was down", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      // First server: the voice delegates, then the server goes away.
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_one",
          text: "Run the tests",
        });
        yield* nextOf(client.events, "delegation");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
      assert.equal(yield* Queue.take(harness.outbound), "closed");

      // Second server on the same database: the run has settled meanwhile.
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        const client = yield* subscribeAs("tab-1");
        yield* readBack.start();
        const answered = yield* nextOf(client.events, "delegation");
        assert.equal(answered.delegation.status, "answered");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offer(harness.inbound, {
          type: "session.started",
          sessionId: "rtc_2",
          expiresAt: 0,
        });
        const answer = spokenText(yield* Queue.take(harness.outbound));
        assert.include(answer, "session.context.append");
        assert.include(answer, "From Alpha: All 128 tests pass.");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it("turns Markdown into short speakable text", () => {
    assert.equal(
      VoiceCallReadBack.readBackText("## Done\n\n- **one** [link](https://x)\n- `two`"),
      "Done one link two",
    );
    const long = VoiceCallReadBack.readBackText("This is a sentence. ".repeat(400), 200);
    assert.isAtMost(new TextEncoder().encode(long).length, 200);
    assert.match(long, /sentence\. The rest is in the thread\.$/);
  });
});
