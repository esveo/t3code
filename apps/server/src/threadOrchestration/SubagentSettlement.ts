/**
 * Fork: subagents settle with the thread that started them. Settling a thread
 * means its work is done; its subagent threads (provider-native ones and
 * delegate_task children alike) would otherwise stay in the thread list as
 * orphans that have to be settled one by one.
 *
 * A subagent follows its parent when it has no settled override of its own:
 * one the user reopened ("active") stays open. One still running when its
 * parent settles cannot be settled yet and follows once its run ends. On
 * start, subagents left open under an already settled parent are caught up.
 * Settling a subagent never settles its parent.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

type SettlementShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "archivedAt" | "deletedAt" | "settledOverride"
>;

/** Whether `child` is an open subagent of `parent` that should settle with it. */
export function followsSettledParent(child: SettlementShell, parent: SettlementShell): boolean {
  return (
    child.lineage.relationshipToParent === "subagent" &&
    child.lineage.parentThreadId === parent.id &&
    child.archivedAt === null &&
    child.deletedAt === null &&
    child.settledOverride === null &&
    parent.deletedAt === null &&
    parent.settledOverride === "settled"
  );
}

/** Every subagent among `shells` whose parent is settled while it is not. */
export function subagentsToSettle(
  shells: ReadonlyArray<SettlementShell>,
  parentId?: ThreadId,
): ReadonlyArray<ThreadId> {
  const byId = new Map(shells.map((shell) => [shell.id, shell]));
  return shells.flatMap((child) => {
    const parentThreadId = child.lineage.parentThreadId;
    if (parentThreadId === null || (parentId !== undefined && parentThreadId !== parentId)) {
      return [];
    }
    const parent = byId.get(parentThreadId);
    return parent !== undefined && followsSettledParent(child, parent) ? [child.id] : [];
  });
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const settle = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`fork:settle-with-parent:${threadId}:${uuid}`),
        threadId,
      });
    }).pipe(
      // A subagent with a live run refuses; it follows when the run ends.
      Effect.catchCause((cause) =>
        Effect.logDebug("subagent-settlement.settle-skipped", { threadId, cause }),
      ),
    );

  const settleAll = (parentId?: ThreadId) =>
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      yield* Effect.forEach(subagentsToSettle(snapshot.threads, parentId), settle, {
        discard: true,
      });
    });

  const settleIfOrphaned = (childId: ThreadId) =>
    Effect.gen(function* () {
      const child = yield* threads.getThreadShell(childId);
      const parentId = child?.lineage.parentThreadId ?? null;
      if (child === null || parentId === null || child.settledOverride !== null) return;
      const parent = yield* threads.getThreadShell(parentId);
      if (parent !== null && followsSettledParent(child, parent)) yield* settle(childId);
    });

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    const work =
      event.type === "thread.settled"
        ? settleAll(event.threadId)
        : event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status)
          ? settleIfOrphaned(event.threadId)
          : Effect.void;
    return work.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("subagent-settlement.failed", { threadId: event.threadId, cause }),
      ),
    );
  };

  yield* forkParked(
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(threads.streamDomainEvents, processEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("subagent-settlement.stream-failed", { cause }),
          ),
        ),
      );
      yield* settleAll().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("subagent-settlement.catch-up-failed", { cause }),
        ),
      );
    }),
  );
});

export const layer = Layer.effectDiscard(make);
