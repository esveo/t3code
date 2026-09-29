import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderAdapterV2SessionRuntime } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderSubagentControl from "./ProviderSubagentControl.ts";

const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");
const PROVIDER_THREAD = ProviderThreadId.make("provider-thread");
const SESSION = ProviderSessionId.make("session");

type Records = Pick<OrchestrationV2ThreadProjection, "thread" | "subagents" | "providerThreads">;

function makeDeps(input: {
  readonly driver: string;
  readonly runtime: Pick<ProviderAdapterV2SessionRuntime, "stopSubagent"> | null;
}) {
  // Only the fields the controls read; the rest of each record is irrelevant here.
  const records = new Map<ThreadId, Records>([
    [
      CHILD,
      {
        thread: { lineage: { parentThreadId: PARENT, relationshipToParent: "subagent" } },
        subagents: [],
        providerThreads: [],
      } as unknown as Records,
    ],
    [
      PARENT,
      {
        thread: { activeProviderThreadId: PROVIDER_THREAD, lineage: {} },
        subagents: [
          {
            childThreadId: CHILD,
            origin: "provider_native",
            driver: ProviderDriverKind.make(input.driver),
            providerThreadId: null,
            nativeTaskRef: { nativeId: "task-7" },
            title: "Review the diff",
          },
        ],
        providerThreads: [{ id: PROVIDER_THREAD, providerSessionId: SESSION }],
      } as unknown as Records,
    ],
  ]);
  const deps = {
    getThreadRecords: (threadId: ThreadId) => Effect.succeed(records.get(threadId)!),
    getSession: (sessionId: ProviderSessionId) =>
      Effect.succeed(
        sessionId === SESSION && input.runtime !== null
          ? Option.some(input.runtime as ProviderAdapterV2SessionRuntime)
          : Option.none(),
      ),
  } as unknown as ProviderSubagentControl.ProviderSubagentControlDeps;
  return deps;
}

it.effect("names the subagent a relay addresses on the parent", () =>
  Effect.gen(function* () {
    const target = yield* ProviderSubagentControl.target(
      makeDeps({ driver: "claudeAgent", runtime: null }),
      { threadId: CHILD },
    );
    assert.deepEqual(target, {
      parentThreadId: PARENT,
      agentId: "task-7",
      title: "Review the diff",
      supportsStop: true,
    });
    const codex = yield* ProviderSubagentControl.target(
      makeDeps({ driver: "codex", runtime: null }),
      { threadId: CHILD },
    );
    assert.isFalse(codex.supportsStop);
  }),
);

it.effect("stops the subagent through the parent's live session", () =>
  Effect.gen(function* () {
    const stopped: Array<string> = [];
    yield* ProviderSubagentControl.stop(
      makeDeps({
        driver: "claudeAgent",
        runtime: {
          stopSubagent: ({ providerThread, nativeTaskId }) =>
            Effect.sync(() => {
              stopped.push(`${providerThread.id}:${nativeTaskId}`);
            }),
        },
      }),
      { threadId: CHILD },
    );
    assert.deepEqual(stopped, [`${PROVIDER_THREAD}:task-7`]);
  }),
);

it.effect("reports a provider that cannot stop subagents", () =>
  Effect.gen(function* () {
    const error = yield* ProviderSubagentControl.stop(makeDeps({ driver: "codex", runtime: {} }), {
      threadId: CHILD,
    }).pipe(Effect.flip);
    assert.equal(error.message, "This provider cannot stop subagents.");
  }),
);
