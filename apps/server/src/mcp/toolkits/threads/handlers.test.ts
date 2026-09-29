// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadCoordinators from "../../../threadOrchestration/ThreadCoordinators.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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

const delegatedChild = (id: string) =>
  thread(id, {
    creationSource: "mcp",
    lineage: {
      parentThreadId: COORDINATOR,
      relationshipToParent: "subagent",
      rootThreadId: COORDINATOR,
    },
  });

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (options: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly caller?: ThreadId;
  readonly decisions?: boolean;
  readonly crossProject?: boolean;
}) {
  const threads = [thread("coordinator"), ...options.threads];
  const management = Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(threads.find((candidate) => candidate.id === threadId) ?? null),
    getShellSnapshot: () =>
      Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads, archivedThreads: [] }),
  });
  const settingsContext = yield* Layer.build(
    ServerSettings.layerTest({
      enableThreadDecisions: options.decisions ?? true,
      enableCrossProjectThreads: options.crossProject ?? true,
    }),
  );
  const base = Layer.mergeAll(configLayer, management, Layer.succeedContext(settingsContext));
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
  return { call, coordinators };
});

describe("threads toolkit on V2", () => {
  it.effect("adopts a thread of another project and releases it", () =>
    Effect.gen(function* () {
      const other = thread("docs-thread", { projectId: DOCS, title: "Docs audit" });
      const { call, coordinators } = yield* makeHarness({ threads: [other] });

      const adopted = yield* call("adopt_thread", { threadId: "docs-thread" });
      assert.isTrue(adopted.thread.child);
      assert.strictEqual(adopted.previousParentThreadId, null);
      assert.strictEqual(yield* coordinators.coordinatorOf(other), COORDINATOR);

      const released = yield* call("adopt_thread", { threadId: "docs-thread", detach: true });
      assert.isFalse(released.thread.child);
      assert.strictEqual(yield* coordinators.coordinatorOf(other), null);
    }),
  );

  it.effect("adopts a thread of another project only with cross-project threads on", () =>
    Effect.gen(function* () {
      const other = thread("docs-thread", { projectId: DOCS, title: "Docs audit" });
      const own = thread("web-thread", { title: "Web audit" });
      const { call } = yield* makeHarness({ threads: [other, own], crossProject: false });
      const error = yield* call("adopt_thread", { threadId: "docs-thread" }).pipe(Effect.flip);
      assert.include(error.message, "Cross-project threads");
      const adopted = yield* call("adopt_thread", { threadId: "web-thread" });
      assert.isTrue(adopted.thread.child);
    }),
  );

  it.effect("keeps a child from coordinating", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({
        threads: [delegatedChild("delegated"), thread("unrelated")],
        caller: ThreadId.make("delegated"),
      });
      const error = yield* call("adopt_thread", { threadId: "unrelated" }).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadOrchestrationNestedError");
    }),
  );

  it.effect("refuses decisions while they are off, but still adopts", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({ threads: [thread("other")], decisions: false });
      const error = yield* call("list_decisions", {}).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadOrchestrationFailedError");
      const adopted = yield* call("adopt_thread", { threadId: "other" });
      assert.isTrue(adopted.thread.child);
    }),
  );
});
