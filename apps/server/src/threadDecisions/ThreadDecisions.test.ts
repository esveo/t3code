import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  ThreadManagementService,
  type ThreadManagementSendInput,
} from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadDecisions from "./ThreadDecisions.ts";

const COORDINATOR = ThreadId.make("coordinator");
const CHILD = ThreadId.make("child");
const shell = (id: ThreadId, title: string) =>
  ({
    id,
    title,
    projectId: ProjectId.make("project-1"),
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;

describe("ThreadDecisions on V2", () => {
  it.effect("sends the user's answer to the coordinator and records it", () =>
    Effect.gen(function* () {
      const sent: Array<ThreadManagementSendInput> = [];
      const management = Layer.mock(ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === COORDINATOR
              ? shell(COORDINATOR, "Release 2.0")
              : threadId === CHILD
                ? shell(CHILD, "Import [legacy] data")
                : null,
          ),
        sendToThread: (input) =>
          Effect.sync(() => void sent.push(input)).pipe(Effect.as({} as never)),
      });
      yield* Effect.gen(function* () {
        const decisions = yield* ThreadDecisions.ThreadDecisions;
        yield* decisions.upsert(COORDINATOR, {
          id: "stichtag",
          title: "Cut-off date",
          question: "Which cut-off date should the import use?",
          options: [
            { id: "full", label: "Full history" },
            { id: "recent", label: "Last 12 months" },
          ],
          sourceThreadId: CHILD,
          routeToThreadId: CHILD,
        });
        const [open] = yield* decisions.list(COORDINATOR);
        assert.equal(open?.status, "open");

        yield* decisions.act({
          type: "submit",
          threadId: COORDINATOR,
          replies: [
            { decisionId: "stichtag", optionId: "recent", text: "Older data is archived." },
          ],
        });

        assert.equal(sent.length, 1);
        const message = sent[0]!;
        assert.equal(message.threadId, COORDINATOR);
        assert.equal(message.projectId, "project-1");
        assert.equal(message.mode, "auto");
        assert.include(message.text, "<t3_decisions>");
        assert.include(message.text, "Last 12 months");
        assert.include(message.text, "Older data is archived.");
        // The answer names the thread it is for, so the coordinator passes it on.
        assert.include(message.text, "[Import [legacy) data](t3-thread:child)");

        const [answered] = yield* decisions.list(COORDINATOR);
        assert.equal(answered?.status, "answered");
        assert.deepEqual(answered?.answer, { optionId: "recent", text: "Older data is archived." });
        const snapshot = yield* Stream.runHead(decisions.subscribe(COORDINATOR));
        assert.equal(Option.getOrThrow(snapshot).decisions[0]?.status, "answered");
      }).pipe(
        Effect.provide(
          ThreadDecisions.layer.pipe(
            Layer.provide(Layer.mergeAll(management, SqlitePersistenceMemory, NodeServices.layer)),
          ),
        ),
      );
    }),
  );
});
