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
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";

import { ServerConfig } from "../config.ts";
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

const settledRunOf = (id: string, status: "completed" | "cancelled", startedAt: string | null) =>
  ({
    type: "run.updated",
    threadId: TARGET,
    payload: { id, threadId: TARGET, status, startedAt },
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
  const instructions: Array<string> = [];
  let calls = 0;
  const realtime = Layer.succeed(RealtimeCallClient)({
    createCall: (input) =>
      Effect.sync(() => {
        instructions.push(input.session.instructions);
        return { answerSdp: "v=0 answer", realtimeCallId: `rtc_${++calls}` };
      }),
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
  // Announces every update, as the real service does.
  const settings = Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettingsService.pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            voiceCallEnabled: true,
            providerInstances: { codex: { driver: "codex", config: { homePath: codexHome } } },
          } as Partial<ServerSettings> as never),
        ),
      );
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return {
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      } satisfies ServerSettingsService["Service"];
    }),
  );
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
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "voice-call-test-" }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(realtime, management, settings, projections, engine, NodeServices.layer),
        ),
      ),
    ),
  );
  return { inbound, outbound, sent, instructions, layer };
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
  it.effect("steers the call's thread once per delegation, marked as voice", () =>
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

  it.effect("a delegation carries what was said since the last one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        const transcriptOf = (index: number) =>
          (harness.sent[index]?.context?.records[0] as { payload?: { transcript?: string } })
            ?.payload?.transcript;

        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "split-1", speaker: "user", text: "" },
          { type: "turn.delta", turnId: "split-1", text: "Können wir das in der" },
          { type: "turn.done", turnId: "split-1", speaker: "user", text: "Können wir das in der" },
          { type: "turn.created", turnId: "cut-off", speaker: "voice", text: "" },
          { type: "turn.done", turnId: "cut-off", speaker: "voice", text: "." },
          { type: "turn.created", turnId: "split-2", speaker: "user", text: "" },
          { type: "turn.delta", turnId: "split-2", text: "Sidebar sehen?" },
          { type: "delegation.created", itemId: "item_split", text: "Sidebar sehen?" },
          { type: "turn.done", turnId: "split-2", speaker: "user", text: "Sidebar sehen?" },
        ]);
        yield* nextOf(client.events, "delegation");
        assert.match(harness.sent[0]!.text, /\) Können wir das in der Sidebar sehen\?$/);
        harness.sent.length = 0;

        yield* processed(harness, client.events, "How about a scene around it?");
        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "user-1", speaker: "user", text: "" },
          { type: "delegation.created", itemId: "item_one", text: "Yes, do that" },
          { type: "turn.done", turnId: "user-1", speaker: "user", text: " Yes, do that " },
        ]);
        yield* nextOf(client.events, "delegation");
        assert.equal(transcriptOf(0), "assistant: How about a scene around it?");

        // Its own turn ended after the delegation and must not ride on the next one.
        yield* processed(harness, client.events, "Added.");
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_two",
          text: "Thanks",
        });
        yield* nextOf(client.events, "delegation");
        assert.equal(transcriptOf(1), "assistant: Added.");

        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_three",
          text: "Again",
        });
        yield* nextOf(client.events, "delegation");
        assert.isUndefined(transcriptOf(2));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("a [queue] delegation queues without its marker; a plain one steers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "user-1", speaker: "user", text: "" },
          { type: "delegation.created", itemId: "item_queue", text: "  [QUEUE] Run the tests" },
          { type: "turn.done", turnId: "user-1", speaker: "user", text: "Run the tests" },
        ]);
        const queued = yield* nextOf(client.events, "delegation");
        assert.equal(queued.delegation.text, "Run the tests");
        assert.equal(harness.sent[0]?.mode, "queue");
        assert.match(harness.sent[0]?.text ?? "", /^\[Voice\]\([^)]*\) Run the tests$/);

        yield* processed(harness, client.events, "Queued.");
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_plain",
          text: "Deploy it",
        });
        yield* nextOf(client.events, "delegation");
        assert.equal(harness.sent[1]?.mode, "auto");
        // The queued words were sent, so they must not ride along as transcript.
        const record = harness.sent[1]?.context?.records[0] as {
          payload?: { transcript?: string };
        };
        assert.equal(record.payload?.transcript, "assistant: Queued.");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("a queued delegation is answered by its own later run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offer(harness.inbound, {
          type: "delegation.created",
          itemId: "item_queue",
          text: "[queue] Run the tests",
        });
        yield* nextOf(client.events, "delegation");

        // The run in front of it settles first and is no answer to the delegation.
        yield* readBack.handle(settledRunOf("run-0", "completed", "2026-10-30T12:00:00.000Z"));
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "Update from Alpha:");
        assert.equal((yield* service.delegations)[0]?.status, "open");

        yield* readBack.handle(settledRunOf("run-1", "completed", "2026-10-30T12:01:00.000Z"));
        const answer = spokenText(yield* Queue.take(harness.outbound));
        assert.include(answer, "delegation.context.append");
        assert.include(answer, "item_queue");
        assert.equal((yield* service.delegations)[0]?.status, "answered");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("a queued run that never started says so and leaves the running run's voice_say", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        const saying = yield* service.say(TARGET, "Ich schaue nach").pipe(Effect.forkScoped);
        yield* Queue.take(harness.outbound);
        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "v1", speaker: "voice", text: "" },
          { type: "turn.done", turnId: "v1", speaker: "voice", text: "Ich schaue nach" },
          { type: "delegation.created", itemId: "item_queue", text: "[queue] Run the tests" },
        ]);
        yield* Fiber.join(saying);
        yield* nextOf(client.events, "delegation");

        yield* readBack.handle(settledRunOf("run-1", "cancelled", null));
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "left the queue");

        // The running run used voice_say, so its answer still is not read back.
        yield* readBack.handle(settledRunOf("run-0", "completed", "2026-10-30T12:00:00.000Z"));
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("voice_say returns once spoken, and is not read back again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const readBack = yield* VoiceCallReadBack.VoiceCallReadBack;
        yield* subscribeAs("tab-1");
        assert.equal(yield* service.say(TARGET, "Zu früh"), "no_call");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        const saying = yield* service.say(TARGET, "Ich schaue nach").pipe(Effect.forkScoped);
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "Ich schaue nach");
        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "v1", speaker: "voice", text: "" },
          { type: "turn.done", turnId: "v1", speaker: "voice", text: "Ich schaue nach" },
        ]);
        assert.equal(yield* Fiber.join(saying), "spoken");
        yield* readBack.handle(settledRun("completed"));
        assert.equal(Option.isNone(yield* Queue.poll(harness.outbound)), true);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("an interruption steers the user's words first, then ends voice_say", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        const saying = yield* service.say(TARGET, "Die Tabelle zeigt").pipe(
          Effect.map((status) => ({ status, steered: harness.sent.length })),
          Effect.forkScoped,
        );
        yield* Queue.take(harness.outbound);
        yield* Queue.offerAll(harness.inbound, [
          { type: "turn.created", turnId: "v1", speaker: "voice", text: "" },
          { type: "turn.created", turnId: "u1", speaker: "user", text: "" },
          { type: "turn.done", turnId: "v1", speaker: "voice", text: "Die Tab" },
          { type: "turn.done", turnId: "u1", speaker: "user", text: "Woher kommt die Zahl?" },
          { type: "delegation.created", itemId: "item_dup", text: "Woher kommt die Zahl?" },
        ]);
        assert.deepEqual(yield* Fiber.join(saying), { status: "interrupted", steered: 1 });
        assert.include(harness.sent[0]!.text, "Woher kommt die Zahl?");
        assert.equal(harness.sent[0]!.mode, "auto");
        // The voice delegating the same words gets told, and nothing reaches the thread twice.
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "item_dup");
        assert.equal(harness.sent.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("answers at once when the call has no thread or an archived one", () =>
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

  it.effect("tells the voice when the call moves to another thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: null });

        yield* service.setTarget(TARGET);
        const note = spokenText(yield* Queue.take(harness.outbound));
        assert.include(note, "moved this call");
        assert.include(note, "Alpha");

        // Setting the same thread again is no move.
        yield* service.setTarget(TARGET);
        yield* service.speak("Nothing before this");
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "Nothing before this");

        // A paused call has no session to tell; the next one's instructions name the thread.
        yield* service.pause;
        assert.equal(yield* Queue.take(harness.outbound), "closed");
        yield* service.setTarget(null);
        yield* service.setTarget(TARGET);
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        assert.include(harness.instructions[1] ?? "", '"Alpha"');
        yield* service.speak("Nothing before this either");
        assert.include(
          spokenText(yield* Queue.take(harness.outbound)),
          "Nothing before this either",
        );
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

  it.effect("counts connected time per segment, not the pause between them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        yield* subscribeAs("tab-1");
        const connect = service.connect({
          clientId: "tab-1",
          offerSdp: "v=0 offer",
          target: TARGET,
        });
        yield* connect;
        yield* TestClock.adjust("60 seconds");
        yield* service.pause;
        yield* TestClock.adjust("1000 seconds");
        yield* connect;
        yield* TestClock.adjust("30 seconds");
        // The open segment counts too, while the call runs.
        assert.equal((yield* service.usage).last24HoursSeconds, 90);
        yield* service.hangUp;
        yield* TestClock.adjust("500 seconds");
        const usage = yield* service.usage;
        assert.equal(usage.last24HoursSeconds, 90);
        assert.equal(usage.last30DaysSeconds, 90);
        assert.isTrue(usage.offered);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("records one span per segment on the thread it talked to", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        yield* subscribeAs("tab-1");
        const start = yield* Clock.currentTimeMillis;
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* TestClock.adjust("10 seconds");
        yield* service.setTarget(ARCHIVED);
        yield* TestClock.adjust("20 seconds");
        // The running span shows without an end while the call lasts.
        assert.deepEqual(yield* service.threadSpans(ARCHIVED), [
          { startedAt: start + 10_000, endedAt: null },
        ]);
        yield* service.pause;
        yield* TestClock.adjust("100 seconds");
        yield* service.setTarget(TARGET);
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* TestClock.adjust("5 seconds");
        yield* service.hangUp;

        assert.deepEqual(yield* service.threadSpans(TARGET), [
          { startedAt: start, endedAt: start + 10_000 },
          { startedAt: start + 130_000, endedAt: start + 135_000 },
        ]);
        assert.deepEqual(yield* service.threadSpans(ARCHIVED), [
          { startedAt: start + 10_000, endedAt: start + 30_000 },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("switching the feature off ends the call and refuses a new one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const settings = yield* ServerSettingsService;
        yield* subscribeAs("tab-1");
        const connect = service.connect({
          clientId: "tab-1",
          offerSdp: "v=0 offer",
          target: TARGET,
        });
        yield* connect;
        assert.isTrue((yield* service.usage).offered);
        yield* settings.updateSettings({ voiceCallEnabled: false });
        assert.equal(yield* Queue.take(harness.outbound), "closed");
        assert.isFalse((yield* service.usage).offered);
        const refused = yield* Effect.flip(connect);
        assert.include(refused.message, "off in Settings");
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

  it.effect("reads back an undelegated run of the call's thread once", () =>
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
        yield* processed(harness, client.events, "filler-3");
        assert.isTrue(
          Option.isNone(yield* Queue.poll(harness.outbound)),
          "within the grace period",
        );

        yield* TestClock.adjust("500 millis");
        assert.include(spokenText(yield* Queue.take(harness.outbound)), noTargetAnswer);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect(
    "a user turn longer than the stale limit still holds an injection while they talk",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* VoiceCall.VoiceCallService;
          const client = yield* subscribeAs("tab-1");
          yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
          yield* Queue.offer(harness.inbound, {
            type: "turn.created",
            turnId: "user-1",
            speaker: "user",
            text: "Also",
          });
          yield* processed(harness, client.events, "marker-1");
          yield* service.speak("Update from the agent");

          yield* TestClock.adjust("20 seconds");
          yield* Queue.offer(harness.inbound, {
            type: "turn.delta",
            turnId: "user-1",
            text: " noch",
          });
          yield* processed(harness, client.events, "marker-2");

          // Thinking mid-sentence, 32 s into the turn.
          yield* TestClock.adjust("12 seconds");
          yield* processed(harness, client.events, "marker-3");
          assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)), "user mid-sentence");

          yield* Queue.offer(harness.inbound, {
            type: "turn.done",
            turnId: "user-1",
            speaker: "user",
            text: "Also noch",
          });
          yield* processed(harness, client.events, "marker-4");
          yield* TestClock.adjust("1499 millis");
          yield* processed(harness, client.events, "marker-5");
          assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)), "turn just ended");

          yield* TestClock.adjust("1 millis");
          assert.include(spokenText(yield* Queue.take(harness.outbound)), "Update from the agent");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
        Effect.scoped,
      ),
  );

  it.effect("a user turn that goes silent and never ends stops holding the gate", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offer(harness.inbound, {
          type: "turn.created",
          turnId: "user-1",
          speaker: "user",
          text: "Also",
        });
        yield* processed(harness, client.events, "marker");
        yield* service.speak("Update from the agent");
        yield* TestClock.adjust("30 seconds");
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "Update from the agent");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("voice_say times out while the user keeps talking and is then never spoken", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* VoiceCall.VoiceCallService;
        const client = yield* subscribeAs("tab-1");
        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        yield* Queue.offer(harness.inbound, {
          type: "turn.created",
          turnId: "user-1",
          speaker: "user",
          text: "Also",
        });
        yield* processed(harness, client.events, "marker-1");
        const saying = yield* service.say(TARGET, "Zu spät").pipe(Effect.forkScoped);
        yield* processed(harness, client.events, "marker-2");
        for (const index of [3, 4, 5, 6]) {
          yield* TestClock.adjust("29 seconds");
          yield* Queue.offer(harness.inbound, {
            type: "turn.delta",
            turnId: "user-1",
            text: " und",
          });
          yield* processed(harness, client.events, `marker-${index}`);
        }
        yield* TestClock.adjust("4 seconds");
        assert.equal(yield* Fiber.join(saying), "timed_out");

        yield* Queue.offer(harness.inbound, {
          type: "turn.done",
          turnId: "user-1",
          speaker: "user",
          text: "Also und",
        });
        yield* processed(harness, client.events, "marker-7");
        yield* TestClock.adjust("1500 millis");
        yield* processed(harness, client.events, "marker-8");
        assert.isTrue(Option.isNone(yield* Queue.poll(harness.outbound)));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistenceMemory)),
      Effect.scoped,
    ),
  );

  it.effect("pausing closes the session; resuming recaps the call and tells what finished", () =>
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
        yield* processed(harness, client.events, "Said before the pause");

        yield* service.pause;
        assert.equal(yield* Queue.take(harness.outbound), "closed");
        assert.equal((yield* nextOf(client.events, "call")).call?.state, "paused");
        yield* readBack.handle(settledRun("completed"));

        const resumed = yield* service.connect({
          clientId: "tab-1",
          offerSdp: "v=0 offer",
          target: TARGET,
        });
        assert.equal(resumed.segmentId, "rtc_2");
        assert.include(harness.instructions[1] ?? "", "Said before the pause");
        assert.notInclude(harness.instructions[0] ?? "", "Said before the pause");
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "From Alpha:");
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

  it.effect("a new call knows nothing of the call that was hung up", () =>
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
        yield* processed(harness, client.events, "Said in the old call");

        yield* service.hangUp;
        assert.equal(yield* Queue.take(harness.outbound), "closed");
        yield* readBack.handle(settledRun("completed"));

        yield* service.connect({ clientId: "tab-1", offerSdp: "v=0 offer", target: TARGET });
        assert.notInclude(harness.instructions[1] ?? "", "Said in the old call");
        yield* service.speak("First thing the new call hears");
        assert.include(spokenText(yield* Queue.take(harness.outbound)), "First thing");
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
