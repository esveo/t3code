/**
 * Fork: schema additions of the fork's own features.
 *
 * They are not numbered migrations on purpose. The migrator only runs ids
 * above the newest applied one, so a fork migration would either hide the
 * upstream migration that later takes its number or block every upstream
 * migration after it. Each step here checks before it changes anything, runs
 * after the migrations on every start, and so survives any upstream sync.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ensureForkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  // Thread orchestration: the coordinator a child thread belongs to.
  if (!threadColumns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  }
  // Coordinator decisions: one row per decision, the decision itself as JSON.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_decisions (
      coordinator_thread_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (coordinator_thread_id, decision_id)
    )
  `;
}).pipe(Effect.withSpan("ensureForkSchema"));
