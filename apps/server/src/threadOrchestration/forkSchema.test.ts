import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { initializeV2Database } from "../persistence/initializeV2Database.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ensureForkSchema, importLegacyCoordinatorLinks } from "./forkSchema.ts";

const readLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly thread_id: string; readonly coordinator_thread_id: string | null }>`
    SELECT thread_id, coordinator_thread_id FROM fork_thread_coordinators ORDER BY thread_id
  `;
});

/** A V1 database of the fork: the last V1 migration, plus the fork's V1 schema step. */
const seedV1Fork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  yield* sql`
    CREATE TABLE fork_thread_decisions (
      coordinator_thread_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (coordinator_thread_id, decision_id)
    )
  `;
  const thread = (id: string, parent: string | null, deletedAt: string | null = null) => sql`
    INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at, parent_thread_id)
    VALUES (${id}, 'project-1', ${id}, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', ${deletedAt}, ${parent})
  `;
  yield* thread("coordinator", null);
  yield* thread("started-child", "coordinator");
  yield* thread("assigned-child", "coordinator");
  yield* thread("deleted-child", "coordinator", "2026-09-03T00:00:00.000Z");
  yield* thread("gone-coordinator", null, "2026-09-03T00:00:00.000Z");
  yield* thread("orphan", "gone-coordinator");
  yield* thread("top-level", null);
  yield* sql`
    INSERT INTO fork_thread_decisions (coordinator_thread_id, decision_id, decision_json, updated_at)
    VALUES ('coordinator', 'stichtag', '{"sourceThreadId":"started-child"}', '2026-09-02T00:00:00.000Z')
  `;
});

describe("V1 coordinator links", () => {
  it.effect("become coordinator links on the V2 upgrade, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV1Fork;

      // The first V2 start: every migration, then the fork's schema step.
      yield* runMigrations();
      assert.deepEqual(
        (yield* readLinks).map((row) => [row.thread_id, row.coordinator_thread_id]),
        [
          ["assigned-child", "coordinator"],
          ["started-child", "coordinator"],
        ],
      );
      // Decisions keep pointing at the same threads.
      const decisions = yield* sql<{ readonly decision_json: string }>`
        SELECT decision_json FROM fork_thread_decisions WHERE coordinator_thread_id = 'coordinator'
      `;
      assert.strictEqual(decisions[0]!.decision_json, '{"sourceThreadId":"started-child"}');

      // A release in V2 survives every later start.
      yield* sql`UPDATE fork_thread_coordinators SET coordinator_thread_id = NULL WHERE thread_id = 'started-child'`;
      assert.strictEqual(yield* importLegacyCoordinatorLinks, 0);
      yield* ensureForkSchema;
      assert.deepEqual(
        (yield* readLinks).map((row) => [row.thread_id, row.coordinator_thread_id]),
        [
          ["assigned-child", "coordinator"],
          ["started-child", null],
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is a no-op without the fork's V1 column", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureForkSchema;
      assert.strictEqual((yield* readLinks).length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // Against a copy of a real V1 database (never the live one):
  // FORK_V1_STATE_DB=/path/to/copy.sqlite vp test run src/threadOrchestration/forkSchema.test.ts
  const realDatabase = process.env.FORK_V1_STATE_DB;
  it.effect.skipIf(realDatabase === undefined)("carries the links of a real V1 database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fork-v1-links-" });
      yield* fs.copyFile(realDatabase!, path.join(directory, "state.sqlite"));
      const dbPath = path.join(directory, "statev2.sqlite");
      const start = Effect.gen(function* () {
        yield* initializeV2Database(dbPath);
        return yield* readLinks.pipe(
          Effect.provide(makeSqlitePersistenceLive(dbPath)),
          Effect.scoped,
        );
      });
      const first = yield* start;
      const second = yield* start;
      yield* Effect.logInfo(`real V1 database: ${first.length} coordinator links migrated`);
      assert.isAbove(first.length, 0);
      assert.deepEqual(second, first);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
