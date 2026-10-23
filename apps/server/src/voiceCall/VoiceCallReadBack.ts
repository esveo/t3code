/**
 * Fork: reads results back into a voice call. A run that settles answers the
 * voice's open delegations on it; a run of the thread on screen that nobody
 * delegated, and a new question or approval there, become unprompted
 * updates. See docs/internals/voice-call.md, "Read-back".
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RunStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { VoiceCallService } from "./VoiceCallService.ts";

/** About 1,000 tokens, Codex's budget for a spoken result. */
export const READ_BACK_MAX_BYTES = 4_000;

const SETTLED: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * Turns an agent's Markdown answer into something a voice can read: code
 * stays in the thread, formatting goes, and a long answer is cut at a
 * sentence.
 */
export const readBackText = (markdown: string, maxBytes = READ_BACK_MAX_BYTES): string => {
  const plain = markdown
    .replace(/```[\s\S]*?(```|$)/g, "\n(The code is in the thread.)\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/^\s*\|.*\|\s*$/, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (byteLength(plain) <= maxBytes) return plain;
  const tail = " The rest is in the thread.";
  let cut = plain;
  while (byteLength(cut) > maxBytes - byteLength(tail)) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const kept =
    sentenceEnd > cut.length / 3
      ? cut.slice(0, sentenceEnd + 1)
      : cut.slice(0, Math.max(cut.lastIndexOf(" "), 1));
  return `${kept}${tail}`;
};

export class VoiceCallReadBack extends Context.Service<
  VoiceCallReadBack,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/voiceCall/VoiceCallReadBack") {}

/** Bounded memory of what was already said, since `run.updated` repeats after a run settles. */
const rememberOnce = (seen: Set<string>, key: string) => {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 500) seen.delete(seen.values().next().value as string);
  return true;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService;
  const voice = yield* VoiceCallService;
  const spoken = new Set<string>();
  // The live stream and the re-arm scan may see the same run settle.
  const settling = yield* Semaphore.make(1);

  const titleOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.title ?? "the thread"),
      Effect.orElseSucceed(() => "the thread"),
    );

  const resultOf = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (run.status === "failed") return "The run failed. The details are on screen.";
      if (run.status !== "completed") return "The run was stopped before it finished.";
      const { messages } = yield* projections
        .getThreadRecords(run.threadId, ["messages"], {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
        })
        .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
      const last = messages.findLast((message) => message.text.trim().length > 0);
      return last === undefined ? "It finished without a written answer." : readBackText(last.text);
    });

  const runSettled = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const open = (yield* voice.delegations).filter(
        (delegation) => delegation.status === "open" && delegation.runId === run.id,
      );
      if (open.length > 0) {
        spoken.add(`run:${run.id}`);
        // Steered twice: the newest request gets the answer, the older ones nothing.
        const [newest, ...older] = open.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
        for (const delegation of older) {
          yield* voice.updateDelegation(delegation.id, { status: "superseded" });
        }
        const title = yield* titleOf(run.threadId);
        yield* voice.answerDelegation(newest!.id, `From ${title}: ${yield* resultOf(run)}`);
        return;
      }
      if (run.threadId !== (yield* voice.targetThreadId) || !(yield* voice.live)) return;
      if (!rememberOnce(spoken, `run:${run.id}`)) return;
      const title = yield* titleOf(run.threadId);
      yield* voice.speak(`Update from ${title}: ${yield* resultOf(run)}`);
    }).pipe(settling.withPermits(1));

  const handle: VoiceCallReadBack["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type === "run.updated") {
        if (SETTLED.has(event.payload.status)) yield* runSettled(event.payload);
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.status !== "pending") return;
      const kind = event.payload.kind;
      if (kind === "dynamic_tool_call" || kind === "auth_refresh") return;
      if (event.threadId !== (yield* voice.targetThreadId) || !(yield* voice.live)) return;
      if (!rememberOnce(spoken, `request:${event.payload.id}`)) return;
      const title = yield* titleOf(event.threadId);
      // Answering by voice is postponed (docs: Later); the voice only points to the screen.
      yield* voice.speak(
        kind === "user_input"
          ? `The agent in ${title} asks a question. It waits on screen.`
          : `The agent in ${title} needs an approval. It waits on screen.`,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("voice call: read-back failed", { threadId: event.threadId, cause }),
      ),
    );

  /**
   * Runs that settled while the server was down. `streamDomainEvents` only
   * tails live events, so the open delegations are checked against the
   * projection once the stream runs.
   */
  const reArm = Effect.gen(function* () {
    for (const delegation of yield* voice.delegations) {
      if (delegation.status !== "open" || delegation.threadId === null) continue;
      if (delegation.runId === null) continue;
      const { runs } = yield* projections
        .getThreadRecords(delegation.threadId, ["runs"], { runIds: [delegation.runId] })
        .pipe(Effect.orElseSucceed(() => ({ runs: [] })));
      const run = runs.find((candidate) => candidate.id === delegation.runId);
      if (run === undefined) {
        yield* voice.updateDelegation(delegation.id, { status: "failed" });
      } else if (SETTLED.has(run.status)) {
        yield* runSettled(run);
      }
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("voice call: re-arm failed", { cause })));

  const start: VoiceCallReadBack["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        yield* Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("voice call: read-back event stream failed", { cause }),
          ),
          Effect.forkScoped,
        );
        // A run settling between the subscription and the scan is answered once:
        // whichever settles it second finds the delegation no longer open.
        yield* Effect.yieldNow;
        yield* reArm;
      }),
    );

  return { start, handle } satisfies VoiceCallReadBack["Service"];
});

export const layer = Layer.effect(VoiceCallReadBack, make);

export const startedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* VoiceCallReadBack;
    yield* service.start();
  }),
).pipe(Layer.provide(layer), Layer.provide(ProjectionStore.layer));
