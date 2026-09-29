/**
 * Fork: server side of the controls on a provider-native subagent's thread.
 * The subagent's record lives on its parent thread; the parent's live provider
 * session is what can stop it.
 */
import {
  ProviderDriverKind,
  ProviderSubagentControlError,
  type ProviderSubagentControlInput,
  type ProviderSubagentTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import type { ProviderSessionManagerV2Shape } from "../orchestration-v2/ProviderSessionManager.ts";

/** Providers whose adapter implements `stopSubagent`. */
const STOPPABLE_SUBAGENT_DRIVERS: ReadonlySet<string> = new Set([
  ProviderDriverKind.make("claudeAgent"),
]);

export interface ProviderSubagentControlDeps {
  readonly getThreadRecords: OrchestratorV2Shape["getThreadRecords"];
  readonly getSession: ProviderSessionManagerV2Shape["get"];
}

const fail = (message: string) => Effect.fail(new ProviderSubagentControlError({ message }));

const resolveSubagent = Effect.fn("providerSubagentControl.resolve")(function* (
  deps: ProviderSubagentControlDeps,
  input: ProviderSubagentControlInput,
) {
  const unreadable = () => new ProviderSubagentControlError({ message: "Thread is unavailable." });
  const child = yield* deps.getThreadRecords(input.threadId, []).pipe(Effect.mapError(unreadable));
  const parentThreadId = child.thread.lineage.parentThreadId;
  if (child.thread.lineage.relationshipToParent !== "subagent" || parentThreadId === null) {
    return yield* fail("This thread is not a subagent.");
  }
  const parent = yield* deps
    .getThreadRecords(parentThreadId, ["subagents", "providerThreads"])
    .pipe(Effect.mapError(unreadable));
  const subagent = parent.subagents.findLast(
    (candidate) =>
      candidate.childThreadId === input.threadId && candidate.origin === "provider_native",
  );
  const agentId = subagent?.nativeTaskRef?.nativeId;
  if (subagent === undefined || agentId == null) {
    return yield* fail("The subagent's record is unavailable.");
  }
  const providerThread = parent.providerThreads.find(
    (candidate) =>
      candidate.id === (subagent.providerThreadId ?? parent.thread.activeProviderThreadId),
  );
  return { parentThreadId, subagent, agentId, providerThread };
});

export const target = (
  deps: ProviderSubagentControlDeps,
  input: ProviderSubagentControlInput,
): Effect.Effect<ProviderSubagentTarget, ProviderSubagentControlError> =>
  resolveSubagent(deps, input).pipe(
    Effect.map(({ parentThreadId, subagent, agentId }) => ({
      parentThreadId,
      agentId,
      title: subagent.title,
      supportsStop: STOPPABLE_SUBAGENT_DRIVERS.has(subagent.driver),
    })),
  );

export const stop = Effect.fn("providerSubagentControl.stop")(function* (
  deps: ProviderSubagentControlDeps,
  input: ProviderSubagentControlInput,
) {
  const { providerThread, agentId } = yield* resolveSubagent(deps, input);
  const session =
    providerThread?.providerSessionId == null
      ? Option.none()
      : yield* deps
          .getSession(providerThread.providerSessionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
  if (providerThread === undefined || Option.isNone(session)) {
    return yield* fail("The subagent is not running.");
  }
  const stopSubagent = session.value.stopSubagent;
  if (stopSubagent === undefined) {
    return yield* fail("This provider cannot stop subagents.");
  }
  yield* stopSubagent({ providerThread, nativeTaskId: agentId }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSubagentControlError({
          message: "detail" in cause ? String(cause.detail) : "The subagent could not be stopped.",
        }),
    ),
  );
  return {};
});
