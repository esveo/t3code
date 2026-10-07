/**
 * Fork: the notes and todos of the Notes tab.
 *
 * One table for all three scopes (thread, project, global); global means the
 * whole environment. Writes go one at a time, renumber the positions of every
 * scope they touch, and then tell the open subscriptions of those scopes,
 * which answer with the scope's full list again. It stays small.
 */
import {
  type ForkNote,
  type ForkNoteScope,
  type ForkNotesAction,
  ForkNotesError,
  type ForkNotesSnapshot,
  type ForkNotesTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

export class ForkNotes extends Context.Service<
  ForkNotes,
  {
    readonly list: (
      target: ForkNotesTarget,
    ) => Effect.Effect<ReadonlyArray<ForkNote>, ForkNotesError>;
    readonly act: (action: ForkNotesAction) => Effect.Effect<void, ForkNotesError>;
    /** The scope's list now, then again after every change to it. */
    readonly subscribe: (
      target: ForkNotesTarget,
    ) => Stream.Stream<ForkNotesSnapshot, ForkNotesError>;
  }
>()("t3/forkNotes/ForkNotes") {}

interface NoteRow {
  readonly id: string;
  readonly scope: ForkNoteScope;
  readonly scope_id: string;
  readonly text: string;
  readonly todo: number;
  readonly done: number;
  readonly position: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const toNote = (row: NoteRow): ForkNote => ({
  id: row.id,
  scope: row.scope,
  scopeId: row.scope_id,
  text: row.text,
  todo: row.todo !== 0,
  done: row.todo !== 0 && row.done !== 0,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const scopeKey = (target: ForkNotesTarget) => `${target.scope}:${target.scopeId}`;

const failure = (message: string) => new ForkNotesError({ message });

/** Global has no id; a thread or project scope needs one. */
const validateTarget = (target: ForkNotesTarget) =>
  target.scope === "global"
    ? target.scopeId === ""
      ? Effect.void
      : Effect.fail(failure("Global notes have no scope id."))
    : target.scopeId.trim().length > 0
      ? Effect.void
      : Effect.fail(failure(`Notes of a ${target.scope} need its id.`));

const insertAt = <A>(items: ReadonlyArray<A>, position: number, item: A) => {
  const index = Math.max(0, Math.min(position, items.length));
  return [...items.slice(0, index), item, ...items.slice(index)];
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<string>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const storeFailed = (detail: string) => () => failure(`Could not ${detail} the notes.`);

  const list: ForkNotes["Service"]["list"] = (target) =>
    sql<NoteRow>`
      SELECT id, scope, scope_id, text, todo, done, position, created_at, updated_at
      FROM fork_notes
      WHERE scope = ${target.scope} AND scope_id = ${target.scopeId}
      ORDER BY position, created_at, id
    `.pipe(
      Effect.map((rows) => rows.map(toNote)),
      Effect.mapError(storeFailed("read")),
    );

  const find = (id: string) =>
    sql<NoteRow>`
      SELECT id, scope, scope_id, text, todo, done, position, created_at, updated_at
      FROM fork_notes WHERE id = ${id}
    `.pipe(
      Effect.mapError(storeFailed("read")),
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(toNote(rows[0])) : Effect.fail(failure("The note was not found.")),
      ),
    );

  /** Saves the order of one scope's list as positions 0, 1, 2, … */
  const renumber = (notes: ReadonlyArray<ForkNote>) =>
    Effect.forEach(
      notes.flatMap((note, position) => (note.position === position ? [] : [{ note, position }])),
      ({ note, position }) =>
        sql`UPDATE fork_notes SET position = ${position} WHERE id = ${note.id}`,
      { discard: true },
    ).pipe(Effect.mapError(storeFailed("save")));

  const insert = (note: ForkNote) =>
    sql`
      INSERT INTO fork_notes (id, scope, scope_id, text, todo, done, position, created_at, updated_at)
      VALUES (${note.id}, ${note.scope}, ${note.scopeId}, ${note.text}, ${note.todo ? 1 : 0},
        ${note.done ? 1 : 0}, ${note.position}, ${note.createdAt}, ${note.updatedAt})
    `.pipe(Effect.mapError(storeFailed("save")));

  const save = (note: ForkNote) =>
    sql`
      UPDATE fork_notes
      SET scope = ${note.scope}, scope_id = ${note.scopeId}, text = ${note.text},
        todo = ${note.todo ? 1 : 0}, done = ${note.done ? 1 : 0}, updated_at = ${note.updatedAt}
      WHERE id = ${note.id}
    `.pipe(Effect.mapError(storeFailed("save")));

  /** Runs one change and returns the scopes it touched. */
  const apply = (
    action: ForkNotesAction,
  ): Effect.Effect<ReadonlyArray<ForkNotesTarget>, ForkNotesError> =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      switch (action.type) {
        case "create": {
          const target = { scope: action.scope, scopeId: action.scopeId };
          yield* validateTarget(target);
          if (action.id !== undefined) {
            const taken = yield* find(action.id).pipe(Effect.option);
            if (Option.isSome(taken)) return yield* failure("A note with this id already exists.");
          }
          const note: ForkNote = {
            id: action.id ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            scope: action.scope,
            scopeId: action.scopeId,
            text: action.text,
            todo: action.todo,
            done: action.todo && (action.done ?? false),
            position: Number.MAX_SAFE_INTEGER,
            createdAt: now,
            updatedAt: now,
          };
          const notes = yield* list(target);
          yield* insert(note);
          yield* renumber(insertAt(notes, action.position ?? 0, note));
          return [target];
        }
        case "update": {
          const note = yield* find(action.id);
          const todo = action.todo ?? note.todo;
          if (!todo && action.done === true) return yield* failure("A note cannot be done.");
          yield* save({
            ...note,
            text: action.text ?? note.text,
            todo,
            done: todo && (action.done ?? note.done),
            updatedAt: now,
          });
          return [note];
        }
        case "move": {
          const note = yield* find(action.id);
          const target = { scope: action.scope, scopeId: action.scopeId };
          yield* validateTarget(target);
          if (!note.todo && action.done === true) return yield* failure("A note cannot be done.");
          const moved: ForkNote = {
            ...note,
            scope: action.scope,
            scopeId: action.scopeId,
            done: note.todo && (action.done ?? note.done),
            updatedAt: now,
          };
          const sameScope = scopeKey(note) === scopeKey(target);
          const others = (yield* list(target)).filter((other) => other.id !== note.id);
          yield* save(moved);
          yield* renumber(insertAt(others, action.position, moved));
          if (sameScope) return [target];
          yield* renumber((yield* list(note)).filter((other) => other.id !== note.id));
          return [note, target];
        }
        case "delete": {
          const note = yield* find(action.id);
          yield* sql`DELETE FROM fork_notes WHERE id = ${note.id}`.pipe(
            Effect.mapError(storeFailed("delete")),
          );
          yield* renumber(yield* list(note));
          return [note];
        }
      }
    });

  const act: ForkNotes["Service"]["act"] = (action) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const touched = yield* apply(action).pipe(
          sql.withTransaction,
          Effect.catchTags({ SqlError: storeFailed("save") }),
        );
        for (const target of touched) {
          yield* PubSub.publish(changes, scopeKey(target));
        }
      }),
    );

  const subscribe: ForkNotes["Service"]["subscribe"] = (target) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* validateTarget(target);
        const key = scopeKey(target);
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = Effect.map(list(target), (notes) => ({ notes }));
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === key),
            Stream.mapEffect(() => snapshot),
          ),
        );
      }),
    );

  return ForkNotes.of({ list, act, subscribe });
});

export const layer = Layer.effect(ForkNotes, make);

/**
 * The RPC side reads the service optionally, so it does not join the
 * requirements of every server test that builds the RPC layer.
 */
const withService = <A>(use: (notes: ForkNotes["Service"]) => Effect.Effect<A, ForkNotesError>) =>
  Effect.flatMap(Effect.serviceOption(ForkNotes), (notes) =>
    Option.isSome(notes)
      ? use(notes.value)
      : Effect.fail(failure("This server does not keep notes.")),
  );

export const subscribeRpc = (target: ForkNotesTarget) =>
  Stream.unwrap(withService((notes) => Effect.succeed(notes.subscribe(target))));

export const actRpc = (action: ForkNotesAction) =>
  withService((notes) => notes.act(action)).pipe(Effect.as({}));
