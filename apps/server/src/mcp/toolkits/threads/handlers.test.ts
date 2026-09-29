// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ChatAttachment,
} from "@t3tools/contracts";
import { parseTaggedThreadMessage } from "@t3tools/shared/threadOrchestration";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import {
  ThreadManagementService,
  type ThreadManagementSendInput,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadCoordinators from "../../../threadOrchestration/ThreadCoordinators.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const at = DateTime.makeUnsafe("2026-09-23T10:00:00.000Z");
const WEB = ProjectId.make("project-web");
const DOCS = ProjectId.make("project-docs");
const COORDINATOR = ThreadId.make("coordinator");

const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-threads-toolkit-"));
const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
  Layer.provideMerge(NodeServices.layer),
);

function thread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: WEB,
    title: id,
    createdBy: "user",
    creationSource: "web",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    branch: null,
    worktreePath: null,
    status: "completed",
    activityRunStatus: null,
    latestRunId: RunId.make(`run-${id}`),
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    lastError: null,
    pullRequests: [],
    hasActionableProposedPlan: false,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

const delegatedChild = (id: string, projectId = WEB) =>
  thread(id, {
    projectId,
    creationSource: "mcp",
    lineage: {
      parentThreadId: COORDINATOR,
      relationshipToParent: "subagent",
      rootThreadId: COORDINATOR,
    },
  });

const projects: ReadonlyArray<OrchestrationProjectShell> = [
  { id: WEB, title: "Web", workspaceRoot: "/workspace/web" } as OrchestrationProjectShell,
  { id: DOCS, title: "Docs site", workspaceRoot: "/workspace/docs" } as OrchestrationProjectShell,
];

interface Delegation {
  readonly input: OrchestratorMcpDelegateTaskInput;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
}

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (options: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly caller?: ThreadId;
  readonly enabled?: boolean;
  readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
}) {
  const threads = [thread("coordinator"), ...options.threads];
  const sent: Array<ThreadManagementSendInput> = [];
  const delegations: Array<Delegation> = [];
  const management = Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(threads.find((candidate) => candidate.id === threadId) ?? null),
    getShellSnapshot: () =>
      Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads, archivedThreads: [] }),
    ensureLegacyTranscript: () => Effect.void,
    getThreadRecords: ((threadId: ThreadId) =>
      Effect.succeed({
        subagents: [],
        messages: (options.answers?.[threadId] ?? []).map((text, index) => ({
          id: MessageId.make(`${threadId}-answer-${index}`),
          role: "assistant",
          text,
          streaming: false,
          attachments: [],
        })),
      })) as never,
    sendToThread: (input) => Effect.sync(() => void sent.push(input)).pipe(Effect.as({} as never)),
    dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
  });
  const orchestrator = Layer.mock(OrchestratorMcpService)({
    delegateTask: (_scope, input, fork) =>
      Effect.sync(() => {
        delegations.push({ input, attachments: fork?.attachments });
        return {
          taskId: NodeId.make("task-1"),
          childThreadId: ThreadId.make("new-child"),
        } as never;
      }),
    capabilities: () =>
      Effect.succeed({
        inheritedProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
        providers: [
          {
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            driverKind: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude",
            models: [{ id: "opus", label: null }],
            canRunChildTask: true,
          },
          {
            providerInstanceId: ProviderInstanceId.make("codex"),
            driverKind: ProviderDriverKind.make("codex"),
            displayName: null,
            models: [{ id: "gpt-5.4", label: null }],
            canRunChildTask: true,
          },
        ],
      } as never),
  });
  const projectService = Layer.mock(ProjectService.ProjectService)({
    listShells: () => Effect.succeed(projects),
    getById: (id) =>
      Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === id) as never)),
  });
  const settingsContext = yield* Layer.build(
    ServerSettings.layerTest({
      enableThreadOrchestration: options.enabled ?? true,
      enableThreadDecisions: true,
    }),
  );
  const base = Layer.mergeAll(
    configLayer,
    management,
    orchestrator,
    projectService,
    Layer.succeedContext(settingsContext),
  );
  // Built once, so the links' in-memory database lives as long as the harness.
  const coordinatorsContext = yield* Layer.build(
    ThreadCoordinators.layer.pipe(
      Layer.provide(Layer.mergeAll(base, Layer.fresh(SqlitePersistenceMemory))),
    ),
  );
  const dependencies = Layer.mergeAll(base, Layer.succeedContext(coordinatorsContext));
  const coordinators = Context.get(coordinatorsContext, ThreadCoordinators.ThreadCoordinators);
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof ThreadsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: options.caller ?? COORDINATOR,
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { call, sent, delegations, coordinators };
});

describe("threads toolkit on V2", () => {
  it.effect("starts a thread as a delegated task in another project's own worktree", () =>
    Effect.gen(function* () {
      const brief = NodePath.join(baseDir, "brief.md");
      NodeFS.writeFileSync(brief, "# Brief\n");
      const { call, delegations } = yield* makeHarness({ threads: [] });
      const result = yield* call("start_thread", {
        title: "Docs for 2.0",
        prompt: "Write the upgrade guide.",
        project: "Docs site",
        baseBranch: "main",
        provider: "codex",
        model: "gpt-5.4",
        language: "German",
        attachments: [{ path: brief }],
      });
      assert.deepEqual(result, {
        threadId: "new-child",
        taskId: "task-1",
        link: "[Docs for 2.0](t3-thread:new-child)",
        branch: null,
        worktree: true,
      });
      const [delegation] = delegations;
      assert.deepEqual(delegation?.input.workspace, {
        project: "Docs site",
        worktree: true,
        baseRef: "main",
      });
      assert.deepEqual(delegation?.input.target, {
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
      assert.equal(delegation?.input.mode, "async");
      const task = parseTaggedThreadMessage(delegation?.input.task ?? "");
      assert.equal(task?.threadId, "coordinator");
      assert.include(task?.body ?? "", "Write the upgrade guide.");
      assert.include(task?.body ?? "", "in German");
      assert.deepEqual(
        delegation?.attachments?.map((attachment) => attachment.name),
        ["brief.md"],
      );
    }),
  );

  it.effect("adopts a thread of another project, messages it, and releases it", () =>
    Effect.gen(function* () {
      const other = thread("docs-thread", { projectId: DOCS, title: "Docs audit" });
      const { call, sent } = yield* makeHarness({
        threads: [other],
        answers: { "docs-thread": ["First answer.", "Latest answer."] },
      });
      // Reading works on any thread, across projects; messaging only on its own.
      const read = yield* call("read_thread", { threadId: "docs-thread" });
      assert.deepEqual(read.latestAnswers, ["Latest answer."]);
      assert.isFalse(read.thread.child);
      const refused = yield* call("send_to_thread", {
        threadId: "docs-thread",
        message: "Go on.",
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "ChildThreadNotFoundError");

      const adopted = yield* call("adopt_thread", { threadId: "docs-thread" });
      assert.isTrue(adopted.thread.child);
      assert.strictEqual(adopted.previousParentThreadId, null);
      yield* call("send_to_thread", { threadId: "docs-thread", message: "Add a summary." });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.projectId, DOCS);
      assert.equal(sent[0]!.senderThreadId, COORDINATOR);
      assert.equal(sent[0]!.mode, "auto");
      assert.equal(parseTaggedThreadMessage(sent[0]!.text)?.body, "Add a summary.");

      const listed = yield* call("list_threads", {});
      assert.deepEqual(
        listed.threads.map((summary) => summary.threadId),
        ["docs-thread"],
      );
      yield* call("adopt_thread", { threadId: "docs-thread", detach: true });
      assert.equal((yield* call("list_threads", {})).threads.length, 0);
    }),
  );

  it.effect("lists delegated children as the coordinator's threads", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({
        threads: [delegatedChild("delegated"), thread("unrelated")],
      });
      const listed = yield* call("list_threads", {});
      assert.deepEqual(
        listed.threads.map((summary) => [summary.threadId, summary.state, summary.child]),
        [["delegated", "done", true]],
      );
      const all = yield* call("list_threads", { scope: "all" });
      assert.deepEqual(all.threads.map((summary) => summary.threadId).toSorted(), [
        "delegated",
        "unrelated",
      ]);
    }),
  );

  it.effect("keeps a child from coordinating", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({
        threads: [delegatedChild("delegated")],
        caller: ThreadId.make("delegated"),
      });
      const error = yield* call("start_thread", { title: "Nested", prompt: "Nope." }).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "ThreadOrchestrationNestedError");
    }),
  );

  it.effect("lists projects with the providers delegate_task can run", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({ threads: [] });
      const listed = yield* call("list_projects", {} as never);
      assert.deepEqual(
        listed.projects.map((project) => [project.title, project.current]),
        [
          ["Web", true],
          ["Docs site", false],
        ],
      );
      assert.deepEqual(
        listed.providers.map((provider) => [provider.provider, provider.name, provider.current]),
        [
          ["claudeAgent", "Claude", true],
          ["codex", "codex", false],
        ],
      );
    }),
  );

  it.effect("refuses every tool while thread orchestration is off", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({ threads: [], enabled: false });
      const error = yield* call("list_threads", {}).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadOrchestrationDisabledError");
    }),
  );
});
