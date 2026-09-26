/**
 * Fork: the initiatives' entries besides the Inbox: decisions, assumptions,
 * issues, tasks and the rest of the log, with their origin, links and
 * replacements. A new version never overwrites: it supersedes the old entry,
 * which stays with status superseded. Inbox items (questions and tasks for
 * the user) are entries too, but they change only through ThreadDecisions.
 */
import {
  type Initiative,
  type InitiativeAuthor,
  type InitiativeEntry,
  type InitiativeEntryLinkKind,
  type InitiativeEntryType,
  InitiativesError,
  type InitiativesInboxSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { ENTRY_STATUSES, entryStatusBlocker, isEntryOpen } from "@t3tools/initiatives/model";
import type { InitiativeStore } from "@t3tools/initiatives/store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const failure = (message: string) => new InitiativesError({ message });

export interface EntryInput {
  readonly initiativeId: string | null;
  readonly type: InitiativeEntryType;
  readonly title: string;
  readonly bodyMd?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly originThreadId?: ThreadId | null | undefined;
  readonly supersedes?: string | null | undefined;
  readonly status?: string | undefined;
}

export const makeInitiativeEntries = (options: {
  readonly store: InitiativeStore;
  readonly changed: (initiativeId: string | null) => Effect.Effect<unknown>;
  /** The initiative of a thread now, for Inbox items whose coordinator moved. */
  readonly initiativeOfThread: (threadId: string) => Effect.Effect<Initiative | null>;
}) => {
  const { store, changed } = options;
  const fromStore = (error: { readonly message: string }) => failure(error.message);

  const requireEntry = (entryId: string) =>
    store.get("entry", entryId).pipe(
      Effect.mapError(fromStore),
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.succeed(found.value)
          : Effect.fail(failure(`No entry ${entryId}.`)),
      ),
    );

  const create = (input: EntryInput, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      const status = input.status ?? ENTRY_STATUSES[input.type][0];
      const blocker = entryStatusBlocker({ type: input.type, status }, status, author);
      if (blocker) return yield* failure(blocker);
      const entry = yield* store
        .insert(
          "entry",
          {
            initiativeId: input.initiativeId,
            type: input.type,
            title: input.title,
            bodyMd: input.bodyMd ?? "",
            status,
            details: { ...input.details },
            origin: { threadId: input.originThreadId ?? null, messageId: null },
            supersedes: input.supersedes ?? null,
            inbox: null,
            urgency: null,
            dependsOn: [],
            routeToThreadId: null,
            snoozedAt: null,
            legacyKey: null,
          },
          author,
        )
        .pipe(Effect.mapError(fromStore));
      yield* changed(entry.initiativeId);
      return entry;
    });

  /**
   * Moves an entry on. A refuted assumption marks the decisions that depend
   * on it for review.
   */
  const setStatus = (entryId: string, status: string, author: InitiativeAuthor, note?: string) =>
    Effect.gen(function* () {
      const entry = yield* requireEntry(entryId);
      if (entry.inbox) {
        return yield* failure("This is an Inbox item; answer it in its coordinator's Inbox.");
      }
      const blocker = entryStatusBlocker(entry, status, author);
      if (blocker) return yield* failure(blocker);
      const updated = yield* store
        .update(
          "entry",
          entry.id,
          {
            status,
            ...(note?.trim() ? { details: { ...entry.details, statusNote: note.trim() } } : {}),
          },
          { author },
        )
        .pipe(Effect.mapError(fromStore));
      if (entry.type === "assumption" && status === "refuted") {
        const links = yield* store
          .list("link", { initiativeId: entry.initiativeId })
          .pipe(Effect.mapError(fromStore));
        for (const link of links) {
          if (link.kind !== "dependsOn" || link.toId !== entry.id) continue;
          const dependent = yield* store.get("entry", link.fromId).pipe(Effect.mapError(fromStore));
          if (Option.isSome(dependent) && dependent.value.type === "decision") {
            yield* store
              .update(
                "entry",
                dependent.value.id,
                {
                  details: {
                    ...dependent.value.details,
                    needsReview: true,
                    refutedAssumption: entry.id,
                  },
                },
                { author },
              )
              .pipe(Effect.mapError(fromStore));
          }
        }
      }
      yield* changed(entry.initiativeId);
      return updated;
    });

  /** A new version of an entry; the old one keeps its history as superseded. */
  const supersede = (
    entryId: string,
    input: Omit<EntryInput, "initiativeId" | "type" | "supersedes">,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const old = yield* requireEntry(entryId);
      if (old.inbox) return yield* failure("Inbox items change through their coordinator's Inbox.");
      if (!(ENTRY_STATUSES[old.type] as ReadonlyArray<string>).includes("superseded")) {
        return yield* failure(`A ${old.type} is not superseded; change its status instead.`);
      }
      return yield* store
        .transaction(
          Effect.gen(function* () {
            const next = yield* create(
              { ...input, initiativeId: old.initiativeId, type: old.type, supersedes: old.id },
              author,
            );
            yield* store.update("entry", old.id, { status: "superseded" }, { author });
            return next;
          }),
        )
        .pipe(Effect.mapError(fromStore));
    });

  const link = (
    fromId: string,
    toId: string,
    kind: InitiativeEntryLinkKind,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      if (fromId === toId) return yield* failure("An entry cannot link to itself.");
      const from = yield* requireEntry(fromId);
      yield* requireEntry(toId);
      const created = yield* store
        .insert("link", { initiativeId: from.initiativeId, fromId, toId, kind }, author)
        .pipe(
          Effect.catchTag("InitiativeStoreError", (error) =>
            error.reason === "duplicate"
              ? store
                  .findByKey("link", `${fromId}|${kind}|${toId}`)
                  .pipe(
                    Effect.flatMap((found) =>
                      Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail(error),
                    ),
                  )
              : Effect.fail(error),
          ),
          Effect.mapError(fromStore),
        );
      yield* changed(from.initiativeId);
      return created;
    });

  /**
   * What waits on the user across all initiatives: open Inbox items and
   * proposed decisions. Inbox items group by their coordinator's initiative now.
   */
  const inboxSnapshot = Effect.gen(function* () {
    const entries = yield* store.list("entry").pipe(Effect.mapError(fromStore));
    const initiatives = yield* store.list("initiative").pipe(Effect.mapError(fromStore));
    const titles = new Map(initiatives.map((initiative) => [initiative.id, initiative.title]));
    const byCoordinator = new Map<string, Initiative | null>();
    const items: Array<InitiativesInboxSnapshot["items"][number]> = [];
    for (const entry of entries) {
      const waiting = entry.inbox
        ? isEntryOpen(entry)
        : entry.type === "decision" && entry.status === "proposed";
      if (!waiting) continue;
      let initiativeId = entry.initiativeId;
      if (entry.inbox) {
        const coordinatorId = entry.inbox.threadId;
        if (!byCoordinator.has(coordinatorId)) {
          byCoordinator.set(coordinatorId, yield* options.initiativeOfThread(coordinatorId));
        }
        initiativeId = byCoordinator.get(coordinatorId)?.id ?? entry.initiativeId;
      }
      items.push({
        entry,
        initiativeId,
        initiativeTitle: initiativeId ? (titles.get(initiativeId) ?? null) : null,
      });
    }
    return { items } satisfies InitiativesInboxSnapshot;
  });

  return { create, setStatus, supersede, link, inboxSnapshot, requireEntry };
};

export type InitiativeEntries = ReturnType<typeof makeInitiativeEntries>;

/** Entries a thread's tools list: the initiative's, newest first, open ones unless asked. */
export function selectEntries(
  entries: ReadonlyArray<InitiativeEntry>,
  filter: {
    readonly type?: InitiativeEntryType | undefined;
    readonly status?: string | undefined;
    readonly includeClosed?: boolean | undefined;
  },
): ReadonlyArray<InitiativeEntry> {
  return entries
    .filter(
      (entry) =>
        (filter.type === undefined || entry.type === filter.type) &&
        (filter.status === undefined || entry.status === filter.status) &&
        (filter.includeClosed === true || filter.status !== undefined || isEntryOpen(entry)),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}
