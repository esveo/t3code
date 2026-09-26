import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { Initiatives } from "../Initiatives.ts";
import { makeTestInitiatives, TEST_PROJECT, testShell } from "../testFakes.ts";
import { InitiativesToolkitHandlersLive } from "./handlers.ts";
import { InitiativesToolkit } from "./tools.ts";

const ROBERT = "person:robert";

const makeHarness = Effect.gen(function* () {
  const harness = yield* makeTestInitiatives;
  const { initiatives, fake } = harness;
  for (const threadId of ["coordinator", "member", "outsider"]) {
    fake.threads.set(threadId, testShell(threadId));
  }
  const initiativeId = (yield* initiatives.act({ type: "create", title: "Relaunch" }, ROBERT)).id!;
  yield* initiatives.act({ type: "addProject", initiativeId, projectId: TEST_PROJECT }, ROBERT);
  for (const threadId of ["coordinator", "member"]) {
    yield* initiatives.act(
      { type: "assignThread", initiativeId, threadId: ThreadId.make(threadId) },
      ROBERT,
    );
  }
  yield* initiatives.store.update(
    "initiative",
    initiativeId,
    { coordinatorThreadId: ThreadId.make("coordinator") },
    { author: ROBERT },
  );

  let keys = 0;
  const toolkit = yield* InitiativesToolkit.pipe(
    Effect.provide(
      InitiativesToolkitHandlersLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Initiatives, Initiatives.of(initiatives)),
            Layer.succeed(Crypto.Crypto, {
              ...Crypto.make({
                randomBytes: (size) => new Uint8Array(size),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
              randomUUIDv4: Effect.sync(() => `key-${++keys}`),
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
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof InitiativesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make(caller),
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        issuedAt: 1,
      }),
    );
  return { ...harness, initiativeId, call };
});

describe("initiatives toolkit", () => {
  it.effect("lets members read their initiative and only the coordinator change it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const brief = yield* harness.call("member", "initiative_brief", {});
      assert.equal(brief.role, "participant");
      assert.equal(brief.projects[0]?.label, "Web");

      const refused = yield* Effect.flip(
        harness.call("member", "initiative_start_thread", { title: "Nope", prompt: "Nope" }),
      );
      assert.include(refused.message, "coordinator");
      const outsider = yield* Effect.flip(harness.call("outsider", "initiative_brief", {}));
      assert.include(outsider.message, "does not belong");

      const started = yield* harness.call("coordinator", "initiative_start_thread", {
        title: "Landing page",
        prompt: "Build it.",
        key: "task-1",
      });
      const again = yield* harness.call("coordinator", "initiative_start_thread", {
        title: "Landing page",
        prompt: "Build it.",
        key: "task-1",
      });
      assert.equal(started.threadId, again.threadId);
      assert.equal(harness.fake.starts.length, 1);
      const job = (yield* harness.initiatives.detailSnapshot(harness.initiativeId)).launchJobs[0]!;
      assert.equal(job.spec.parentThreadId, "coordinator");
      assert.equal(job.createdBy, "role:coordinator:coordinator");
    }),
  );

  it.effect("lets a coordinator tighten provider exclusions but never loosen them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.call("coordinator", "initiative_update", { excludeProviders: ["grok"] });
      yield* harness.call("coordinator", "initiative_update", { excludeProviders: ["cursor"] });
      const brief = yield* harness.call("coordinator", "initiative_brief", {});
      assert.deepEqual(brief.providerExclusions, ["grok", "cursor"]);
    }),
  );

  it.effect("keeps a person's correction of a brain page against the coordinator", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.call("coordinator", "brain_write", {
        path: "details/api.md",
        markdown: "# API\nREST",
      });
      const found = yield* harness.call("member", "brain_search", { query: "rest" });
      assert.deepEqual(
        found.hits.map((hit) => hit.path),
        ["details/api.md"],
      );
      const memberWrite = yield* Effect.flip(
        harness.call("member", "brain_write", { path: "details/api.md", markdown: "x" }),
      );
      assert.include(memberWrite.message, "coordinator");

      yield* harness.initiatives.act(
        {
          type: "brainWrite",
          initiativeId: harness.initiativeId,
          path: "details/api.md",
          markdown: "# API\nGraphQL",
        },
        ROBERT,
      );
      const blocked = yield* Effect.flip(
        harness.call("coordinator", "brain_write", {
          path: "details/api.md",
          markdown: "# API\nREST",
        }),
      );
      assert.include(blocked.message, "person corrected");
      const page = yield* harness.call("member", "brain_read", { path: "details/api.md" });
      assert.include(page.markdown ?? "", "GraphQL");

      yield* harness.initiatives.act(
        { type: "brainUnlock", initiativeId: harness.initiativeId, path: "details/api.md" },
        ROBERT,
      );
      yield* harness.call("coordinator", "brain_write", {
        path: "details/api.md",
        markdown: "# API\nREST again",
      });
    }),
  );

  it.effect("writes the handoff a fresh coordinator starts from", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.call("coordinator", "handoff_update", {
        openTasks: ["Review the landing page"],
        lastResults: ["Landing page: PR #12 open"],
        nextStep: "Merge PR #12",
      });
      const handoff = yield* harness.call("member", "brain_read", { path: "handoff.md" });
      assert.include(handoff.markdown ?? "", "- Review the landing page");
      assert.include(handoff.markdown ?? "", "> Landing page: PR #12 open");
      assert.include(handoff.markdown ?? "", "Merge PR #12");
      const refused = yield* Effect.flip(
        harness.call("member", "handoff_update", { openTasks: [], lastResults: [], nextStep: "" }),
      );
      assert.include(refused.message, "coordinator");
    }),
  );
});
