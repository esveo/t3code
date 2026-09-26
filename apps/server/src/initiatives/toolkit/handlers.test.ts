import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadBridge } from "@t3tools/initiatives/bridge";
import { ensureInitiativeSchema, makeInitiativeStore } from "@t3tools/initiatives/store";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { Initiatives, makeInitiatives } from "../Initiatives.ts";
import { InitiativesToolkitHandlersLive } from "./handlers.ts";
import { InitiativesToolkit } from "./tools.ts";

const PROJECT = ProjectId.make("project-1");
const shell = (id: string) =>
  ({
    id: ThreadId.make(id),
    projectId: PROJECT,
    title: id,
    branch: null,
    worktreePath: null,
  }) as OrchestrationThreadShell;

const makeHarness = Effect.gen(function* () {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* ensureInitiativeSchema(sql);
  let counter = 0;
  const newId = Effect.sync(() => `id-${++counter}`);
  const threads = new Map([
    ["coordinator", shell("coordinator")],
    ["member", shell("member")],
    ["outsider", shell("outsider")],
  ]);
  const starts: Array<string> = [];
  const bridge: ThreadBridge = {
    capabilities: { runtimeModes: ["auto"], lineage: "one-level" },
    resolveModel: () =>
      Effect.succeed({
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        driver: "codex",
      }),
    startThread: (job) =>
      Effect.sync(() => {
        starts.push(job.threadId);
        threads.set(job.threadId, shell(job.threadId));
        return { threadId: job.threadId, branch: null, worktree: true };
      }),
    findThread: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
    listThreads: () => Effect.succeed([...threads.values()]),
    listProjects: () =>
      Effect.succeed([{ projectId: PROJECT, title: "Web", workspaceRoot: "/repo/web" }]),
  };
  const initiatives = yield* makeInitiatives({
    store: makeInitiativeStore({ sql, newId }),
    bridge,
    newId,
    environmentId: null,
    readUsage: () => Effect.succeed(null),
  });
  const robert = "person:robert";
  const initiativeId = (yield* initiatives.act({ type: "create", title: "Relaunch" }, robert)).id!;
  yield* initiatives.act({ type: "addProject", initiativeId, projectId: PROJECT }, robert);
  for (const threadId of ["coordinator", "member"]) {
    yield* initiatives.act(
      { type: "assignThread", initiativeId, threadId: ThreadId.make(threadId) },
      robert,
    );
  }
  yield* initiatives.store.update(
    "initiative",
    initiativeId,
    { coordinatorThreadId: ThreadId.make("coordinator") },
    { author: robert },
  );

  const toolkit = yield* InitiativesToolkit.pipe(
    Effect.provide(
      InitiativesToolkitHandlersLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Initiatives, Initiatives.of(initiatives)),
            Layer.succeed(Crypto.Crypto, {
              ...Crypto.make({
                randomBytes: (size) => new Uint8Array(size),
                digest: (_a, data) => Effect.succeed(data),
              }),
              randomUUIDv4: Effect.sync(() => `key-${++counter}`),
            }),
          ),
        ),
      ),
    ),
  );
  const call = <Name extends keyof typeof InitiativesToolkit.tools>(
    caller: string,
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make(caller),
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        issuedAt: 1,
      }),
    );
  const result = <Name extends keyof typeof InitiativesToolkit.tools>(
    caller: string,
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    call(caller, name, params).pipe(
      Effect.map((part) => part.result as Tool.Success<(typeof InitiativesToolkit.tools)[Name]>),
    );
  return { initiatives, initiativeId, call, result, starts };
});

describe("initiatives toolkit", () => {
  it.effect("lets members read their initiative and only the coordinator change it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const brief = yield* harness.result("member", "initiative_brief", {});
      assert.equal(brief.role, "participant");
      assert.equal(brief.projects[0]?.label, "Web");

      const refused = yield* Effect.flip(
        harness.call("member", "initiative_start_thread", { title: "Nope", prompt: "Nope" }),
      );
      assert.include(refused.message, "coordinator");
      const outsider = yield* Effect.flip(harness.call("outsider", "initiative_brief", {}));
      assert.include(outsider.message, "does not belong");

      const started = yield* harness.result("coordinator", "initiative_start_thread", {
        title: "Landing page",
        prompt: "Build it.",
        key: "task-1",
      });
      const again = yield* harness.result("coordinator", "initiative_start_thread", {
        title: "Landing page",
        prompt: "Build it.",
        key: "task-1",
      });
      assert.equal(started.threadId, again.threadId);
      assert.equal(harness.starts.length, 1);
      const job = (yield* harness.initiatives.detailSnapshot(harness.initiativeId)).launchJobs[0]!;
      assert.equal(job.spec.parentThreadId, "coordinator");
      assert.equal(job.createdBy, "role:coordinator:coordinator");
    }),
  );

  it.effect("lets a coordinator tighten provider exclusions but never loosen them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.result("coordinator", "initiative_update", { excludeProviders: ["grok"] });
      yield* harness.result("coordinator", "initiative_update", { excludeProviders: ["cursor"] });
      const brief = yield* harness.result("coordinator", "initiative_brief", {});
      assert.deepEqual(brief.providerExclusions, ["grok", "cursor"]);
    }),
  );
});
