import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  parentsAnswerChildQuestions,
  requireAnswerFromAskingThread,
  waitingDescendantIds,
} from "./childQuestions.ts";

const parent = ThreadId.make("parent");
const child = ThreadId.make("child");
const grandchild = ThreadId.make("grandchild");

const sibling = ThreadId.make("sibling");
const project = ProjectId.make("project:mine");
const otherProject = ProjectId.make("project:other");

type Caller = ThreadId | "linked-agent" | "client" | undefined;

const callerScope = (caller: Caller): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:child-questions"),
  requestNamespace: "thread:child-questions",
  thread:
    caller === undefined || caller === "linked-agent" || caller === "client"
      ? undefined
      : ({ threadId: caller } as McpInvocationContext.McpThreadCaller),
  client:
    caller === "linked-agent" || caller === "client"
      ? ({
          sessionId: "client",
          label: "client",
          ...(caller === "linked-agent" ? { linked: true, senderThread: {} } : {}),
        } as McpInvocationContext.McpClientCaller)
      : undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const answer = (caller: Caller, parentsAnswer: boolean) =>
  requireAnswerFromAskingThread(child).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(caller)),
    Effect.provide(ServerSettings.layerTest({ parentsAnswerChildQuestions: parentsAnswer })),
    Effect.flip,
    Effect.option,
  );

describe("childQuestions", () => {
  it.effect("lets parents answer by default and without settings", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* parentsAnswerChildQuestions);
      assert.isTrue(
        yield* parentsAnswerChildQuestions.pipe(Effect.provide(ServerSettings.layerTest())),
      );
      assert.isFalse(
        yield* parentsAnswerChildQuestions.pipe(
          Effect.provide(ServerSettings.layerTest({ parentsAnswerChildQuestions: false })),
        ),
      );
    }),
  );

  it.effect("refuses another thread's answer only while the user answers", () =>
    Effect.gen(function* () {
      const refused = yield* answer(parent, false);
      assert.isTrue(refused._tag === "Some");
      if (refused._tag === "Some" && "code" in refused.value) {
        assert.equal(refused.value.code, "invalid_request");
        assert.include(refused.value.message, `in thread ${child}`);
      }
      assert.isTrue((yield* answer(parent, true))._tag === "None");
      assert.isTrue((yield* answer(child, false))._tag === "None");
      assert.isTrue((yield* answer(undefined, false))._tag === "None");
      assert.isTrue((yield* answer("linked-agent", false))._tag === "Some");
      assert.isTrue((yield* answer("linked-agent", true))._tag === "None");
      assert.isTrue((yield* answer("client", false))._tag === "None");
    }),
  );

  it.effect("lists a waiting grandchild under its parent and the parent's parent", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const lineage = (parentThreadId: ThreadId | null) => ({
        parentThreadId,
        relationshipToParent: parentThreadId === null ? null : "subagent",
      });
      const index = [
        { id: parent, projectId: project, lineage: lineage(null), mayBeLive: true },
        { id: child, projectId: project, lineage: lineage(parent), mayBeLive: true },
        { id: grandchild, projectId: otherProject, lineage: lineage(child), mayBeLive: true },
        { id: sibling, projectId: project, lineage: lineage(null), mayBeLive: true },
      ];
      const built: Array<ReadonlyArray<ThreadId>> = [];
      const threads = {
        listActiveShellIndex: () => Effect.succeed(index as never),
        getShellSnapshot: (input: { readonly threadIds: ReadonlyArray<ThreadId> }) => {
          built.push(input.threadIds);
          return Effect.succeed({
            threads: input.threadIds.map((id) => ({
              id,
              pendingRuntimeRequest:
                id === grandchild || id === sibling
                  ? { id: RuntimeRequestId.make("question"), createdAt: now }
                  : null,
            })),
          } as never);
        },
      };
      const userAnswers = (crossProject: boolean) =>
        ServerSettings.layerTest({
          parentsAnswerChildQuestions: false,
          enableCrossProjectThreads: crossProject,
        });

      const waiting = yield* waitingDescendantIds(
        threads as never,
        [parent, child, grandchild],
        project,
      ).pipe(Effect.provide(userAnswers(true)));
      assert.deepEqual(waiting.get(parent), [grandchild]);
      assert.deepEqual(waiting.get(child), [grandchild]);
      assert.isUndefined(waiting.get(grandchild));
      assert.deepEqual(built, [[child, grandchild]]);

      built.length = 0;
      const outOfReach = yield* waitingDescendantIds(threads as never, [parent], project).pipe(
        Effect.provide(userAnswers(false)),
      );
      assert.isUndefined(outOfReach.get(parent));
      assert.deepEqual(built, [[child]]);

      built.length = 0;
      const leaf = yield* waitingDescendantIds(threads as never, [sibling], project).pipe(
        Effect.provide(userAnswers(true)),
      );
      assert.equal(leaf.size, 0);
      assert.deepEqual(built, []);
    }),
  );
});
