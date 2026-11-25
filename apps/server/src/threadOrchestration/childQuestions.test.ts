import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
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

const callerScope = (threadId: ThreadId | undefined): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:child-questions"),
  requestNamespace: "thread:child-questions",
  thread:
    threadId === undefined ? undefined : ({ threadId } as McpInvocationContext.McpThreadCaller),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const answer = (caller: ThreadId | undefined, parentsAnswer: boolean) =>
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
      if (refused._tag === "Some") {
        assert.equal(refused.value.code, "invalid_request");
        assert.include(refused.value.message, `in thread ${child}`);
      }
      assert.isTrue((yield* answer(parent, true))._tag === "None");
      assert.isTrue((yield* answer(child, false))._tag === "None");
      assert.isTrue((yield* answer(undefined, false))._tag === "None");
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
        { id: parent, lineage: lineage(null), mayBeLive: true },
        { id: child, lineage: lineage(parent), mayBeLive: true },
        { id: grandchild, lineage: lineage(child), mayBeLive: true },
      ];
      const waiting = yield* waitingDescendantIds({
        listActiveShellIndex: () => Effect.succeed(index as never),
        getShellSnapshot: () =>
          Effect.succeed({
            threads: index.map(({ id }) => ({
              id,
              pendingRuntimeRequest:
                id === grandchild
                  ? { id: RuntimeRequestId.make("question"), createdAt: now }
                  : null,
            })),
          } as never),
      }).pipe(Effect.provide(ServerSettings.layerTest({ parentsAnswerChildQuestions: false })));
      assert.deepEqual(waiting.get(parent), [grandchild]);
      assert.deepEqual(waiting.get(child), [grandchild]);
      assert.isUndefined(waiting.get(grandchild));
    }),
  );
});
