/* oxlint-disable t3code/no-low-value-comments -- fork module documents a cross-service rule */
/**
 * Fork: who answers a child thread's questions. With "Parent threads answer
 * child questions" on (Settings → Threads, `parentsAnswerChildQuestions`, the
 * default) a coordinator is woken for its delegated tasks' questions and may
 * answer them through t3_pending_request, as upstream does. Off, only the user
 * answers, in the thread that asked: no wake reaches the parent, and an agent
 * thread's answer to another thread's question is refused. The user then sees
 * "Waiting for you" on every thread above one that waits on them, and the MCP
 * thread tools list those threads (`waitingForUserThreadIds`).
 *
 * The setting is read on each use and optionally, so upstream's tests and
 * layers keep upstream's behaviour.
 */
import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import { waitingDescendantsByThread } from "@t3tools/shared/threadOrchestration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadCoordinators } from "./ThreadCoordinators.ts";

/** Whether coordinating threads may answer their children's questions, right now. */
export const parentsAnswerChildQuestions: Effect.Effect<boolean> = Effect.serviceOption(
  ServerSettingsService,
).pipe(
  Effect.flatMap((settings) =>
    Option.isNone(settings)
      ? Effect.succeed(true)
      : settings.value.getSettings.pipe(
          Effect.map((current) => current.parentsAnswerChildQuestions),
          Effect.orElseSucceed(() => true),
        ),
  ),
);

/** Refuses an agent thread's answer to a question of another thread while only the user answers. */
export const requireAnswerFromAskingThread = Effect.fn(
  "childQuestions.requireAnswerFromAskingThread",
)(function* (askingThreadId: ThreadId) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = scope.thread?.threadId;
  if (caller === undefined || caller === askingThreadId) return;
  if (yield* parentsAnswerChildQuestions) return;
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `The user answers questions of other threads themselves (Parent threads answer child questions is off in Settings → Threads). Leave this question to them in thread ${askingThreadId}, and do not ask them about it here.`,
  });
});

/**
 * For each thread, the active threads below it whose own approval or question
 * waits on the user (shared `waitingDescendantsByThread`), while only the user
 * answers; empty otherwise, so the default costs nothing. Only threads that can
 * be live can wait, so only their shells are built.
 */
export const waitingDescendantIds = Effect.fn("childQuestions.waitingDescendantIds")(function* (
  threads: Pick<ThreadManagementServiceShape, "listActiveShellIndex" | "getShellSnapshot">,
) {
  if (yield* parentsAnswerChildQuestions) return new Map<ThreadId, ReadonlyArray<ThreadId>>();
  const index = yield* threads.listActiveShellIndex();
  const liveIds = index.flatMap((entry) => (entry.mayBeLive ? [entry.id] : []));
  if (liveIds.length === 0) return new Map<ThreadId, ReadonlyArray<ThreadId>>();
  const live = yield* threads.getShellSnapshot({ location: "active", threadIds: liveIds });
  const pendingById = new Map(
    live.threads.map((shell) => [shell.id, shell.pendingRuntimeRequest] as const),
  );
  const coordinators = yield* Effect.serviceOption(ThreadCoordinators);
  const overrides = Option.isNone(coordinators)
    ? new Map<ThreadId, ThreadId | null>()
    : yield* coordinators.value.overrides.pipe(
        Effect.orElseSucceed(() => new Map<ThreadId, ThreadId | null>()),
      );
  const byThread = waitingDescendantsByThread(
    index.map((entry) => ({
      id: entry.id,
      lineage: entry.lineage,
      pendingRuntimeRequest: pendingById.get(entry.id) ?? null,
    })),
    overrides,
  );
  return new Map(
    [...byThread].map(([threadId, waiting]) => [threadId, waiting.map((thread) => thread.id)]),
  );
});

/** The `waitingForUserThreadIds` field of a thread in the MCP thread tools, absent when none wait. */
export const waitingForUserField = (
  waiting: ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>>,
  threadId: ThreadId,
): { readonly waitingForUserThreadIds?: ReadonlyArray<ThreadId> } => {
  const ids = waiting.get(threadId);
  return ids === undefined || ids.length === 0 ? {} : { waitingForUserThreadIds: ids };
};
