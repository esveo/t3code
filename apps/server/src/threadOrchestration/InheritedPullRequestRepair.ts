/**
 * Fork: drops the pull request links subagent threads inherited from their
 * parent. Until upstream's fix (#14918), a subagent thread (a delegate_task
 * child among them) was created as a copy of its parent and took every pull
 * request linked to the parent along, so the coordinator's panel listed
 * finished children as ready for review with someone else's pull request. A link made before the child existed can only
 * be such a copy. Runs once on start; the unlinks make it a no-op afterwards.
 */
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

type RepairShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "createdAt" | "pullRequests" | "deletedAt"
>;

export interface InheritedPullRequestLink extends ThreadPullRequestKey {
  readonly threadId: ThreadId;
}

/** Links of subagent threads that are older than the thread itself. */
export function inheritedPullRequestLinks(
  shells: ReadonlyArray<RepairShell>,
): ReadonlyArray<InheritedPullRequestLink> {
  return shells.flatMap((shell) => {
    if (shell.deletedAt !== null || shell.lineage.relationshipToParent !== "subagent") return [];
    const createdAtMs = DateTime.toEpochMillis(shell.createdAt);
    return (shell.pullRequests ?? []).flatMap((link) =>
      link.source !== "stack-dismissed" && Date.parse(link.linkedAt) < createdAtMs
        ? [
            {
              threadId: shell.id,
              host: link.host,
              repository: link.repository,
              number: link.number,
            },
          ]
        : [],
    );
  });
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const unlink = (link: InheritedPullRequestLink) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* threads.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make(`fork:inherited-pr-unlink:${link.threadId}:${uuid}`),
        threadId: link.threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("inherited-pr-repair.unlink-failed", { ...link, cause }),
      ),
    );

  yield* forkParked(
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      const links = inheritedPullRequestLinks(snapshot.threads);
      if (links.length === 0) return;
      yield* Effect.logInfo("inherited-pr-repair.unlinking", { links: links.length });
      yield* Effect.forEach(links, unlink, { discard: true });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("inherited-pr-repair.failed", { cause })),
    ),
  );
});

export const layer = Layer.effectDiscard(make);
