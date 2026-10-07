import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ForkNotesTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ForkNotes from "./ForkNotes.ts";

const THREAD: ForkNotesTarget = { scope: "thread", scopeId: "thread-1" };
const OTHER_THREAD: ForkNotesTarget = { scope: "thread", scopeId: "thread-2" };
const PROJECT: ForkNotesTarget = { scope: "project", scopeId: "project-1" };
const GLOBAL: ForkNotesTarget = { scope: "global", scopeId: "" };

const testLayer = ForkNotes.layer.pipe(
  Layer.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer)),
);

const texts = (target: ForkNotesTarget) =>
  Effect.gen(function* () {
    const notes = yield* ForkNotes.ForkNotes;
    return (yield* notes.list(target)).map((note) => note.text);
  });

const create = (target: ForkNotesTarget, id: string, todo = false) =>
  Effect.gen(function* () {
    const notes = yield* ForkNotes.ForkNotes;
    yield* notes.act({ type: "create", ...target, id, text: id, todo });
  });

describe("ForkNotes", () => {
  it.effect("adds new entries at the top unless a position is given", () =>
    Effect.gen(function* () {
      const notes = yield* ForkNotes.ForkNotes;
      yield* create(THREAD, "a");
      yield* create(THREAD, "b", true);
      yield* notes.act({ type: "create", ...THREAD, id: "c", text: "c", todo: false, position: 1 });
      assert.deepEqual(yield* texts(THREAD), ["b", "c", "a"]);
      const listed = yield* notes.list(THREAD);
      assert.deepEqual(
        listed.map((note) => [note.position, note.todo, note.done]),
        [
          [0, true, false],
          [1, false, false],
          [2, false, false],
        ],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("updates text, kind and done, and keeps notes from being done", () =>
    Effect.gen(function* () {
      const notes = yield* ForkNotes.ForkNotes;
      yield* create(THREAD, "a", true);
      yield* notes.act({ type: "update", id: "a", text: "Ship it", done: true });
      let [note] = yield* notes.list(THREAD);
      assert.equal(note?.text, "Ship it");
      assert.isTrue(note?.done);

      // Turning a done todo into a note drops the done state.
      yield* notes.act({ type: "update", id: "a", todo: false });
      [note] = yield* notes.list(THREAD);
      assert.isFalse(note?.todo);
      assert.isFalse(note?.done);

      const error = yield* Effect.flip(notes.act({ type: "update", id: "a", done: true }));
      assert.equal(error.message, "A note cannot be done.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reorders within a scope and checks off in the same step", () =>
    Effect.gen(function* () {
      const notes = yield* ForkNotes.ForkNotes;
      yield* create(THREAD, "c", true);
      yield* create(THREAD, "b", true);
      yield* create(THREAD, "a", true);
      yield* notes.act({ type: "move", id: "a", ...THREAD, position: 2 });
      assert.deepEqual(yield* texts(THREAD), ["b", "c", "a"]);
      yield* notes.act({ type: "move", id: "c", ...THREAD, position: 0, done: true });
      const listed = yield* notes.list(THREAD);
      assert.deepEqual(
        listed.map((note) => [note.text, note.position, note.done]),
        [
          ["c", 0, true],
          ["b", 1, false],
          ["a", 2, false],
        ],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("moves between scopes and renumbers both", () =>
    Effect.gen(function* () {
      const notes = yield* ForkNotes.ForkNotes;
      yield* create(THREAD, "b");
      yield* create(THREAD, "a");
      yield* create(PROJECT, "p");
      yield* notes.act({ type: "move", id: "a", ...PROJECT, position: 1 });
      assert.deepEqual(yield* texts(THREAD), ["b"]);
      assert.deepEqual(yield* texts(PROJECT), ["p", "a"]);
      const [left] = yield* notes.list(THREAD);
      assert.equal(left?.position, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deletes, and a create with the old id and position undoes it", () =>
    Effect.gen(function* () {
      const notes = yield* ForkNotes.ForkNotes;
      yield* create(GLOBAL, "c");
      yield* create(GLOBAL, "b");
      yield* create(GLOBAL, "a");
      yield* notes.act({ type: "delete", id: "b" });
      assert.deepEqual(yield* texts(GLOBAL), ["a", "c"]);
      yield* notes.act({ type: "create", ...GLOBAL, id: "b", text: "b", todo: false, position: 1 });
      assert.deepEqual(yield* texts(GLOBAL), ["a", "b", "c"]);
      const duplicate = yield* Effect.flip(create(GLOBAL, "b"));
      assert.equal(duplicate.message, "A note with this id already exists.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps scopes apart and checks their ids", () =>
    Effect.gen(function* () {
      yield* create(THREAD, "mine");
      yield* create(OTHER_THREAD, "theirs");
      yield* create(GLOBAL, "everyone");
      assert.deepEqual(yield* texts(THREAD), ["mine"]);
      assert.deepEqual(yield* texts(OTHER_THREAD), ["theirs"]);
      assert.deepEqual(yield* texts(PROJECT), []);
      const noId = yield* Effect.flip(create({ scope: "project", scopeId: " " }, "x"));
      assert.equal(noId.message, "Notes of a project need its id.");
      const globalId = yield* Effect.flip(create({ scope: "global", scopeId: "x" }, "x"));
      assert.equal(globalId.message, "Global notes have no scope id.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sends a snapshot, then the scope's list after each change to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notes = yield* ForkNotes.ForkNotes;
        yield* create(THREAD, "first");
        const pull = yield* Stream.toPull(notes.subscribe(THREAD));
        const next = Effect.map(pull, (snapshots) =>
          snapshots.map((snapshot) => snapshot.notes.map((note) => note.text)),
        );
        assert.deepEqual(yield* next, [["first"]]);
        // A change to another scope does not reach this subscription.
        yield* create(OTHER_THREAD, "elsewhere");
        yield* create(THREAD, "second");
        assert.deepEqual(yield* next, [["second", "first"]]);
        yield* notes.act({ type: "move", id: "first", ...PROJECT, position: 0 });
        assert.deepEqual(yield* next, [["second"]]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
