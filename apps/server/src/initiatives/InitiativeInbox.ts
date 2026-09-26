/**
 * Fork: the coordinator Inbox (ThreadDecisions) stored as initiative entries.
 * ThreadDecisions keeps its behaviour; this is only where its items live. An
 * item becomes a `question` (or `task`) entry that holds the whole item in
 * `details.decision` and mirrors the fields other views query: status,
 * urgency, dependsOn, routeToThreadId, snooze. The item's coordinator and id
 * are the entry's unique key, so an upsert finds it again.
 *
 * `importLegacy` takes the items of the old `fork_thread_decisions` table over:
 * missing ones are added, and an item changed there since (a build without
 * this module) replaces the entry. Running it again changes nothing.
 */
import {
  type InitiativeAuthor,
  type InitiativeEntry,
  InitiativesError,
  ThreadDecision,
  type ThreadId,
} from "@t3tools/contracts";
import { entryInboxKey, type InitiativeStore } from "@t3tools/initiatives/store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const failure = (message: string) => new InitiativesError({ message });
const decodeDecision = Schema.decodeUnknownOption(ThreadDecision);
const encodeDecision = Schema.encodeSync(ThreadDecision);

/** The entry status an Inbox item's status maps to. */
export function entryStatusOf(decision: ThreadDecision): string {
  if (decision.kind === "task") {
    return decision.status === "open"
      ? "open"
      : decision.status === "answered"
        ? "done"
        : "cancelled";
  }
  return decision.status === "open"
    ? "open"
    : decision.status === "answered"
      ? "answered"
      : "dismissed";
}

/** The entry fields an Inbox item sets; the rest (id, revision, author) is the store's. */
export function entryFieldsOf(
  decision: ThreadDecision,
  initiativeId: string | null,
  legacyKey: string | null,
) {
  return {
    initiativeId,
    type: decision.kind === "task" ? ("task" as const) : ("question" as const),
    title: decision.title,
    bodyMd: decision.question,
    status: entryStatusOf(decision),
    details: { decision: encodeDecision(decision) },
    origin: { threadId: decision.sourceThreadId ?? decision.coordinatorThreadId, messageId: null },
    supersedes: null,
    inbox: { threadId: decision.coordinatorThreadId, itemId: decision.id },
    urgency: decision.urgency,
    dependsOn: decision.dependsOn,
    routeToThreadId: decision.routeToThreadId,
    snoozedAt: decision.snoozedAt,
    legacyKey,
  } satisfies Omit<
    InitiativeEntry,
    "id" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
  >;
}

export function decisionOfEntry(entry: InitiativeEntry): ThreadDecision | null {
  return Option.getOrNull(decodeDecision(entry.details["decision"]));
}

export const makeInboxStorage = (options: {
  readonly store: InitiativeStore;
  /** The initiative an item belongs to: its coordinator's, else its source thread's. */
  readonly initiativeOf: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<string | null>;
  readonly changed: (initiativeId: string | null) => Effect.Effect<unknown>;
}) => {
  const { store } = options;
  const fromStore = (error: { readonly message: string }) => failure(error.message);

  const list = (coordinatorId: ThreadId) =>
    store.list("entry", { groupKey: coordinatorId }).pipe(
      Effect.mapError(fromStore),
      Effect.map((entries) =>
        entries
          .flatMap((entry) => {
            const decision = decisionOfEntry(entry);
            return decision ? [decision] : [];
          })
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      ),
    );

  const upsert = (decision: ThreadDecision, author: InitiativeAuthor, legacyKey: string | null) =>
    Effect.gen(function* () {
      const key = entryInboxKey(decision.coordinatorThreadId, decision.id);
      const existing = yield* store.findByKey("entry", key);
      if (Option.isSome(existing)) {
        const fields = entryFieldsOf(
          decision,
          existing.value.initiativeId,
          existing.value.legacyKey,
        );
        yield* store.update("entry", existing.value.id, fields, { author });
        return existing.value.initiativeId;
      }
      const initiativeId = yield* options.initiativeOf(
        decision.sourceThreadId
          ? [decision.coordinatorThreadId, decision.sourceThreadId]
          : [decision.coordinatorThreadId],
      );
      yield* store.insert("entry", entryFieldsOf(decision, initiativeId, legacyKey), author);
      return initiativeId;
    });

  /** Writes the items in one transaction, as ThreadDecisions saves a change. */
  const save = (decisions: ReadonlyArray<ThreadDecision>, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      const touched = yield* store
        .transaction(Effect.forEach(decisions, (decision) => upsert(decision, author, null)))
        .pipe(Effect.mapError(fromStore));
      for (const initiativeId of new Set(touched)) yield* options.changed(initiativeId);
    });

  const importLegacy = (decisions: ReadonlyArray<ThreadDecision>) =>
    Effect.gen(function* () {
      let inserted = 0;
      let updated = 0;
      for (const decision of decisions) {
        const key = entryInboxKey(decision.coordinatorThreadId, decision.id);
        const existing = yield* store.findByKey("entry", key).pipe(Effect.mapError(fromStore));
        if (Option.isNone(existing)) {
          yield* upsert(decision, "import:thread-decisions", key).pipe(Effect.mapError(fromStore));
          inserted += 1;
          continue;
        }
        const current = decisionOfEntry(existing.value);
        if (current === null || decision.updatedAt > current.updatedAt) {
          yield* upsert(decision, "import:thread-decisions", existing.value.legacyKey).pipe(
            Effect.mapError(fromStore),
          );
          updated += 1;
        }
      }
      if (inserted + updated > 0) yield* options.changed(null);
      return { inserted, updated };
    });

  return { list, save, importLegacy };
};

export type InboxStorage = ReturnType<typeof makeInboxStorage>;
