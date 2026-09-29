import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { parseThreadUpdates } from "@t3tools/shared/threadOrchestration";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "../orchestration-v2/ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused title link") }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fork-delegated-task-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const TestLayer = Layer.mergeAll(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(PlatformTestLayer),
);

/** A parent thread whose run is live, with a finished delegated task `taskId`. */
const seedParent = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly task?: {
    readonly id: NodeId;
    readonly childThreadId: ThreadId;
    readonly result: string;
  };
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const providerThreadId = ProviderThreadId.make(`provider-thread:${input.threadId}`);
    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Coordinator project",
      workspaceRoot: `/workspace/${input.projectId}`,
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Coordinator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${input.threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-root-node:${input.threadId}`),
          type: "node.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          occurredAt: input.now,
          payload: {
            id: input.rootNodeId,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: null,
            rootNodeId: input.rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: input.now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.task === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: [input.task.id],
                    },
            },
          },
        },
        ...(input.task === undefined
          ? []
          : [
              {
                id: EventId.make(`event:seed-task:${input.threadId}`),
                type: "subagent.updated" as const,
                threadId: input.threadId,
                runId: input.runId,
                nodeId: input.task.id,
                driver,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: input.now,
                payload: {
                  id: input.task.id,
                  threadId: input.threadId,
                  runId: input.runId,
                  parentNodeId: input.rootNodeId,
                  origin: "app_owned" as const,
                  createdBy: "agent" as const,
                  driver,
                  providerInstanceId: modelSelection.instanceId,
                  providerThreadId: null,
                  childThreadId: input.task.childThreadId,
                  nativeTaskRef: null,
                  prompt: "Write the migration report.",
                  title: "Migration report",
                  model: null,
                  completionWake: "always" as const,
                  completionDelivery: { state: "claimed" as const, observedByRunId: null },
                  status: "completed" as const,
                  result: input.task.result,
                  startedAt: input.now,
                  completedAt: input.now,
                  updatedAt: input.now,
                },
              },
            ]),
      ],
    });
  });

it.layer(TestLayer)("fork: delegate_task patches", (it) => {
  it.effect("runs a delegated child in another project and holds its run for the worktree", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projects = yield* ProjectService;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:fork-delegate-workspace");
      const runId = RunId.make("run:fork-delegate-workspace");
      yield* seedParent({
        threadId,
        projectId: ProjectId.make("project:fork-coordinator"),
        runId,
        rootNodeId: NodeId.make("node:fork-delegate-workspace-root"),
        now,
      });
      const otherProjectId = ProjectId.make("project:fork-other");
      yield* projects.create({
        commandId: CommandId.make("command:fork-other-project"),
        projectId: otherProjectId,
        title: "Other repository",
        workspaceRoot: "/workspace/other",
      });
      const result = yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:fork-delegate-workspace"),
        parentThreadId: threadId,
        parentRunId: runId,
        parentNodeId: NodeId.make("node:fork-delegate-workspace-root"),
        task: "Port the importer.",
        title: "Port the importer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        workspace: { projectId: otherProjectId, branch: null, worktreePath: null, prepare: true },
      });
      const created = result.storedEvents.find((stored) => stored.event.type === "thread.created");
      const childThreadId = created?.event.threadId;
      assert.isDefined(childThreadId);
      const child = yield* orchestrator.getThreadProjection(childThreadId!);
      assert.equal(child.thread.projectId, otherProjectId);
      assert.equal(child.thread.lineage.parentThreadId, threadId);
      assert.equal(child.thread.lineage.relationshipToParent, "subagent");
      // The run waits until the worktree is ready (ThreadLaunchService.prepareWorkspace).
      assert.deepEqual(
        child.runs.map((run) => run.status),
        ["preparing"],
      );
    }),
  );

  it.effect("wakes the parent with the child's full answer", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:fork-full-answer");
      const runId = RunId.make("run:fork-full-answer");
      const taskId = NodeId.make("node:fork-full-answer-task");
      const childThreadId = ThreadId.make("thread:fork-full-answer-child");
      const answer = `Report ready: [report](docs/report.md)\n\n${"Finding. ".repeat(500)}`.trim();
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParent({
        threadId,
        projectId: ProjectId.make("project:fork-full-answer"),
        runId,
        rootNodeId: NodeId.make("node:fork-full-answer-root"),
        task: { id: taskId, childThreadId, result: answer },
        now,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:fork-full-answer"),
        threadId,
        messageId,
        text: "Background task finished",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const text = projection.messages.find((message) => message.id === messageId)?.text ?? "";
      // The upstream instruction first, then the result itself.
      assert.isTrue(text.startsWith(`Delegated task ${taskId} reached a terminal state.`));
      const updates = text.slice(text.indexOf("<t3_thread_update"));
      assert.deepEqual(
        parseThreadUpdates(updates)?.map((update) => [update.threadId, update.state, update.body]),
        [[childThreadId, "done", answer]],
      );
    }),
  );
});
