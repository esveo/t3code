import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { readBackgroundTasks } from "./orchestration/BackgroundWorkLedger.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const updatedAt = "2026-09-21T12:00:00.000Z";
const liveBackgroundTasks = [
  { taskId: "a1", kind: "agent", taskType: "local_agent", title: "counter" },
  { taskId: "w1", kind: "workflow", title: "review", runId: "wf_123" },
];

const makeThread = (
  id: string,
  status: OrchestrationSessionStatus,
  activeTurnId: TurnId | null,
) => ({
  id: ThreadId.make(id),
  projectId: "project-1",
  archivedAt: null,
  deletedAt: null,
  interactionMode: "default" as const,
  session: {
    threadId: ThreadId.make(id),
    status,
    providerName: "codex" as const,
    providerInstanceId,
    runtimeMode: "full-access" as const,
    activeTurnId,
    lastError: null,
    updatedAt,
  },
});

const reconcile = (input: {
  readonly thread: ReturnType<typeof makeThread>;
  readonly continueAfterRestart: boolean;
}) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId: input.thread.id,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      status: input.thread.session.status === "running" ? "running" : "stopped",
      resumeCursor: { threadId: input.thread.id },
      runtimePayload: {
        activeTurnId: input.thread.session.activeTurnId,
        liveBackgroundTasks,
      },
    };
    let current = binding;

    yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: [input.thread] } as never),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderService.ProviderService, {
        listSessions: () => Effect.succeed([]),
        // Codex could continue without a prompt; the task list needs one.
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        sendTurn: (turn: ProviderSendTurnInput) =>
          Effect.sync(() => sends.push(turn)).pipe(
            Effect.andThen(Deferred.succeed(sent, undefined)),
            Effect.as({ threadId: turn.threadId, turnId: TurnId.make("continued") }),
          ),
        streamEvents: Stream.empty,
      } as unknown as ProviderService.ProviderService["Service"]),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
        getBinding: () => Effect.sync(() => Option.some(current)),
        upsert: (next) =>
          Effect.sync(() => {
            current = {
              ...current,
              ...next,
              runtimePayload: {
                ...(current.runtimePayload as object),
                ...(next.runtimePayload as object),
              },
            };
          }),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([binding]),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            continueThreadsAfterServerUpdate: input.continueAfterRestart,
          }),
          NodeServices.layer,
        ),
      ),
    );
    if (input.continueAfterRestart) {
      yield* Deferred.await(sent);
    }
    return { sends, dispatched, binding: () => current };
  });

it.effect("resumes background work that outlived its settled turn", () =>
  Effect.gen(function* () {
    const result = yield* reconcile({
      thread: makeThread("thread-background", "ready", null),
      continueAfterRestart: true,
    });

    assert.deepStrictEqual(
      result.dispatched.map((command) =>
        command.type === "thread.session.set" ? command.session.status : command.type,
      ),
      ["starting"],
    );
    assert.strictEqual(result.sends.length, 1);
    const input = result.sends[0]?.input ?? "";
    assert.include(input, 'SendMessage to "a1"');
    assert.include(input, 'resumeFromRunId "wf_123"');
    assert.deepStrictEqual(readBackgroundTasks(result.binding().runtimePayload), []);
  }),
);

it.effect("names interrupted subagents when a running turn continues", () =>
  Effect.gen(function* () {
    const result = yield* reconcile({
      thread: makeThread("thread-running", "running", TurnId.make("turn-running")),
      continueAfterRestart: true,
    });

    assert.strictEqual(result.sends[0]?.continuation, undefined);
    assert.include(result.sends[0]?.input ?? "", 'SendMessage to "a1"');
  }),
);

it.effect("drops background work without an error when continuation is off", () =>
  Effect.gen(function* () {
    const result = yield* reconcile({
      thread: makeThread("thread-off", "ready", null),
      continueAfterRestart: false,
    });

    assert.deepStrictEqual(result.sends, []);
    assert.deepStrictEqual(result.dispatched, []);
    assert.deepStrictEqual(readBackgroundTasks(result.binding().runtimePayload), []);
  }),
);
