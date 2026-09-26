import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureInitiativeSchema, makeInitiativeStore } from "./InitiativeStore.ts";

const ROBERT = "person:robert";

/** A store on a fresh in-memory database, per test. */
const makeStore = Effect.gen(function* () {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* ensureInitiativeSchema(sql);
  let counter = 0;
  return makeInitiativeStore({ sql, newId: Effect.sync(() => `id-${++counter}`) });
});

const initiativeInput = {
  title: "Relaunch",
  goalText: "Ship the relaunch",
  status: "active" as const,
  instructionsMd: "",
  homeEnvironmentId: null,
  providerExclusions: [],
  coordinatorThreadId: null,
  halted: false,
  preflightMode: "shadow" as const,
};

const sessionInput = (initiativeId: string, threadId: string) => ({
  initiativeId,
  source: "t3" as const,
  nativeId: threadId,
  environmentId: null,
  threadId: ThreadId.make(threadId),
  title: "Thread",
  cwd: null,
  branch: null,
  assignment: "confirmed" as const,
  launchJobId: null,
});

describe("InitiativeStore", () => {
  it.effect("writes an audit row with every insert and update", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const created = yield* store.insert("initiative", initiativeInput, ROBERT);
      assert.equal(created.revision, 1);
      assert.equal(created.createdBy, ROBERT);

      const updated = yield* store.update(
        "initiative",
        created.id,
        { title: "Relaunch 2" },
        { author: "role:coordinator:t1" },
      );
      assert.equal(updated.revision, 2);
      assert.equal(updated.updatedBy, "role:coordinator:t1");
      assert.equal(updated.createdBy, ROBERT);

      const audit = yield* store.audit("initiative", created.id);
      assert.equal(audit.length, 2);
      assert.equal(audit[0]?.before, null);
      assert.deepEqual(audit[1]?.before, { title: "Relaunch" });
      assert.deepEqual(audit[1]?.after, { title: "Relaunch 2" });
      assert.equal(audit[1]?.author, "role:coordinator:t1");
    }),
  );

  it.effect("leaves an unchanged record and its revision alone", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const created = yield* store.insert("initiative", initiativeInput, ROBERT);
      const same = yield* store.update(
        "initiative",
        created.id,
        { title: "Relaunch" },
        { author: ROBERT },
      );
      assert.equal(same.revision, 1);
      assert.equal((yield* store.audit("initiative", created.id)).length, 1);
    }),
  );

  it.effect("refuses a change made on a stale revision", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const created = yield* store.insert("initiative", initiativeInput, ROBERT);
      yield* store.update(
        "initiative",
        created.id,
        { title: "A" },
        { author: ROBERT, expectedRevision: 1 },
      );
      const error = yield* Effect.flip(
        store.update(
          "initiative",
          created.id,
          { title: "B" },
          { author: ROBERT, expectedRevision: 1 },
        ),
      );
      assert.equal(error.reason, "conflict");
      const current = yield* store.get("initiative", created.id);
      assert.equal(Option.getOrThrow(current).title, "A");
    }),
  );

  it.effect("keeps a session in one initiative at a time", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const a = yield* store.insert("initiative", initiativeInput, ROBERT);
      const b = yield* store.insert("initiative", { ...initiativeInput, title: "Other" }, ROBERT);
      yield* store.insert("session", sessionInput(a.id, "thread-1"), ROBERT);
      const error = yield* Effect.flip(
        store.insert("session", sessionInput(b.id, "thread-1"), ROBERT),
      );
      assert.equal(error.reason, "duplicate");
      const found = yield* store.findByKey("session", "t3|thread-1");
      assert.equal(Option.getOrThrow(found).initiativeId, a.id);
      assert.equal((yield* store.list("session", { initiativeId: b.id })).length, 0);
    }),
  );

  it.effect("rolls a transaction back as a whole", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const a = yield* store.insert("initiative", initiativeInput, ROBERT);
      const result = yield* Effect.flip(
        store.transaction(
          Effect.gen(function* () {
            yield* store.update("initiative", a.id, { title: "Changed" }, { author: ROBERT });
            yield* store.insert("session", sessionInput(a.id, "thread-1"), ROBERT);
            yield* store.insert("session", sessionInput(a.id, "thread-1"), ROBERT);
          }),
        ),
      );
      assert.equal(result.reason, "duplicate");
      assert.equal(Option.getOrThrow(yield* store.get("initiative", a.id)).title, "Relaunch");
      assert.equal((yield* store.list("session")).length, 0);
      assert.equal((yield* store.audit("initiative", a.id)).length, 1);
    }),
  );

  it.effect("records a removal in the audit", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const a = yield* store.insert("initiative", initiativeInput, ROBERT);
      yield* store.remove("initiative", a.id, ROBERT);
      assert.isTrue(Option.isNone(yield* store.get("initiative", a.id)));
      const audit = yield* store.audit("initiative", a.id);
      assert.equal(audit.length, 2);
      assert.equal(audit[1]?.after, null);
    }),
  );
});
