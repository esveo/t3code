/**
 * Fork: the decisions a coordinator thread asks the user for.
 *
 * Kept in a fork table of their own rather than as thread activities: a
 * thread's detail only carries its latest activities, so on a busy
 * coordinator older open questions would drop out of view, and activities
 * would show up as rows in the chat. The coordinator writes through its MCP
 * tools, the Inbox panel reads through a subscription and replies through
 * `act`; every write tells the open subscriptions of that coordinator.
 */
import {
  CommandId,
  MessageId,
  ThreadDecision,
  type ThreadDecisionsAction,
  ThreadDecisionsError,
  type ThreadDecisionsSnapshot,
  type ThreadDecisionsTarget,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyReply,
  decisionKind,
  formatDecisionReplies,
  isMeaningfulReply,
  reopenDecision,
  resolveDecision,
  snoozeDecision,
  type ThreadDecisionInput,
  upsertDecision,
  validateDecisionInput,
  validateReply,
} from "@t3tools/shared/threadDecisions";
import { threadLinkHref } from "@t3tools/shared/threadOrchestration";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class ThreadDecisions extends Context.Service<
  ThreadDecisions,
  {
    readonly list: (
      coordinatorId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadDecision>, ThreadDecisionsError>;
    /** Creates or replaces a decision; any change also wakes the snoozed ones. */
    readonly upsert: (
      coordinatorId: ThreadId,
      input: ThreadDecisionInput,
    ) => Effect.Effect<ThreadDecision, ThreadDecisionsError>;
    readonly resolve: (
      coordinatorId: ThreadId,
      decisionId: string,
      reason: string,
    ) => Effect.Effect<ThreadDecision, ThreadDecisionsError>;
    /** The user's side: submit replies, snooze, unsnooze, reopen. */
    readonly act: (action: ThreadDecisionsAction) => Effect.Effect<void, ThreadDecisionsError>;
    readonly subscribe: (
      coordinatorId: ThreadId,
    ) => Stream.Stream<ThreadDecisionsSnapshot, ThreadDecisionsError>;
  }
>()("t3/threadDecisions/ThreadDecisions") {}

const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadDecision));

const failure = (message: string) => new ThreadDecisionsError({ message });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<ThreadId>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const storeFailed = (detail: string) => () => failure(`Could not ${detail} the decisions.`);

  const list = (coordinatorId: ThreadId) =>
    sql<{ readonly decision_json: string }>`
      SELECT decision_json FROM fork_thread_decisions
      WHERE coordinator_thread_id = ${coordinatorId}
      ORDER BY json_extract(decision_json, '$.createdAt'), decision_id
    `.pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => Option.toArray(decodeDecision(row.decision_json))),
      ),
      Effect.mapError(storeFailed("read")),
    );

  const save = (decisions: ReadonlyArray<ThreadDecision>) =>
    Effect.forEach(
      decisions,
      (decision) => sql`
        INSERT INTO fork_thread_decisions (coordinator_thread_id, decision_id, decision_json, updated_at)
        VALUES (${decision.coordinatorThreadId}, ${decision.id}, ${JSON.stringify(decision)}, ${decision.updatedAt})
        ON CONFLICT (coordinator_thread_id, decision_id)
        DO UPDATE SET decision_json = excluded.decision_json, updated_at = excluded.updated_at
      `,
      { discard: true },
    ).pipe(sql.withTransaction, Effect.mapError(storeFailed("save")));

  /** Read, change and save one coordinator's decisions without racing another write. */
  const update = <A>(
    coordinatorId: ThreadId,
    change: (
      decisions: ReadonlyArray<ThreadDecision>,
      now: string,
    ) => Effect.Effect<
      { readonly changed: ReadonlyArray<ThreadDecision>; readonly result: A },
      ThreadDecisionsError
    >,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const decisions = yield* list(coordinatorId);
        const { changed, result } = yield* change(decisions, yield* nowIso);
        if (changed.length > 0) {
          yield* save(changed);
          yield* PubSub.publish(changes, coordinatorId);
        }
        return result;
      }),
    );

  const find = (decisions: ReadonlyArray<ThreadDecision>, decisionId: string) => {
    const decision = decisions.find((candidate) => candidate.id === decisionId);
    return decision
      ? Effect.succeed(decision)
      : Effect.fail(
          failure(`No decision ${decisionId}. Call list_decisions for the ids of yours.`),
        );
  };

  const upsert: ThreadDecisions["Service"]["upsert"] = (coordinatorId, input) =>
    update(coordinatorId, (decisions, now) => {
      const existing = decisions.find((decision) => decision.id === input.id) ?? null;
      const invalid = validateDecisionInput(input, decisionKind(existing, input));
      if (invalid) return Effect.fail(failure(invalid));
      const decision = upsertDecision(existing, input, coordinatorId, now);
      // New information from the coordinator is what a snooze waits for.
      const woken = decisions
        .filter((other) => other.id !== input.id && other.snoozedAt !== null)
        .map((other) => snoozeDecision(other, false, now));
      return Effect.succeed({ changed: [decision, ...woken], result: decision });
    });

  const resolve: ThreadDecisions["Service"]["resolve"] = (coordinatorId, decisionId, reason) =>
    update(coordinatorId, (decisions, now) =>
      Effect.map(find(decisions, decisionId), (decision) => {
        const resolved = resolveDecision(decision, reason, "coordinator", now);
        return { changed: [resolved], result: resolved };
      }),
    );

  /** Starts a turn on the coordinator with the replies, as if the user had typed them. */
  const sendReplies = (coordinatorId: ThreadId, text: string) =>
    Effect.gen(function* () {
      const coordinator = yield* snapshots.getThreadShellById(coordinatorId).pipe(
        Effect.mapError(storeFailed("find the coordinator for")),
        Effect.flatMap((thread) =>
          Option.isSome(thread)
            ? Effect.succeed(thread.value)
            : Effect.fail(failure("The coordinator thread was not found.")),
        ),
      );
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:thread-decisions-submit:${yield* uuid}`),
          threadId: coordinator.id,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: coordinator.modelSelection,
          runtimeMode: coordinator.runtimeMode,
          interactionMode: coordinator.interactionMode,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(() => failure("Could not send the replies to the coordinator.")));
    });

  const routeLink = Effect.fn("ThreadDecisions.routeLink")(function* (threadId: ThreadId) {
    const thread = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const title = Option.isSome(thread) ? thread.value.title.replaceAll("]", ")") : threadId;
    return `[${title}](${threadLinkHref(threadId)})`;
  });

  const act: ThreadDecisions["Service"]["act"] = (action) =>
    action.type === "submit"
      ? // One lock from reading to saving: a double submit or a coordinator
        // asking again in between must not be answered with a stale reply.
        writes.withPermits(1)(
          Effect.gen(function* () {
            const replies = action.replies.filter(isMeaningfulReply);
            if (replies.length === 0) return;
            const decisions = yield* list(action.threadId);
            const entries: Array<{ decision: ThreadDecision; reply: (typeof replies)[number] }> =
              [];
            for (const reply of replies) {
              const decision = decisions.find((candidate) => candidate.id === reply.decisionId);
              const invalid = validateReply(decision, reply);
              if (invalid || !decision) return yield* failure(invalid ?? "Unknown decision.");
              entries.push({ decision, reply });
            }
            const links = new Map<ThreadId, string>();
            for (const { decision } of entries) {
              if (decision.routeToThreadId && !links.has(decision.routeToThreadId)) {
                links.set(decision.routeToThreadId, yield* routeLink(decision.routeToThreadId));
              }
            }
            const text = formatDecisionReplies(entries, (threadId) => links.get(threadId) ?? null);
            // The message goes out first: a reply recorded but never delivered
            // would vanish from the Inbox without reaching the coordinator.
            yield* sendReplies(action.threadId, text);
            const now = yield* nowIso;
            yield* save(entries.map(({ decision, reply }) => applyReply(decision, reply, now)));
            yield* PubSub.publish(changes, action.threadId);
          }),
        )
      : update(action.threadId, (decisions, now) =>
          Effect.map(find(decisions, action.decisionId), (decision) => {
            const changed =
              action.type === "reopen"
                ? reopenDecision(decision, now)
                : snoozeDecision(decision, action.type === "snooze", now);
            return { changed: [changed], result: undefined };
          }),
        );

  const subscribe: ThreadDecisions["Service"]["subscribe"] = (coordinatorId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = Effect.map(list(coordinatorId), (decisions) => ({ decisions }));
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === coordinatorId),
            Stream.mapEffect(() => snapshot),
          ),
        );
      }),
    );

  return ThreadDecisions.of({
    list,
    upsert,
    resolve,
    act,
    subscribe,
  });
});

export const layer = Layer.effect(ThreadDecisions, make);

/**
 * The RPC and MCP sides read the service optionally, so neither adds it to the
 * requirements of every server test that builds those layers.
 */
export const withService = <A>(
  use: (decisions: ThreadDecisions["Service"]) => Effect.Effect<A, ThreadDecisionsError>,
) =>
  Effect.flatMap(Effect.serviceOption(ThreadDecisions), (decisions) =>
    Option.isSome(decisions)
      ? use(decisions.value)
      : Effect.fail(failure("This server does not keep decisions.")),
  );

export const subscribeRpc = (target: ThreadDecisionsTarget) =>
  Stream.unwrap(withService((decisions) => Effect.succeed(decisions.subscribe(target.threadId))));

export const actRpc = (action: ThreadDecisionsAction) =>
  withService((decisions) => decisions.act(action)).pipe(Effect.as({}));
