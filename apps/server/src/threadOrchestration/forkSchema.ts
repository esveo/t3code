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

/**
 * Carries the V1 coordinator links into V2. V1 kept a child's coordinator in
 * `projection_threads.parent_thread_id` (started by the coordinator or
 * assigned to it later); V2 imports those threads without lineage, and its
 * lineage cannot change afterwards, so each link becomes a coordinator link
 * row. The V2 database starts as a copy of the V1 one, so the legacy table is
 * right here. `INSERT OR IGNORE` keeps it idempotent and never undoes a move
 * or release made in V2 since. Links to or from deleted threads are left out.
 * Returns how many links it added.
 */
export const importLegacyCoordinatorLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacyColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!legacyColumns.some((column) => column.name === "parent_thread_id")) return 0;
  const before = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fork_thread_coordinators
  `;
  yield* sql`
    INSERT OR IGNORE INTO fork_thread_coordinators (thread_id, coordinator_thread_id, updated_at)
    SELECT child.thread_id, child.parent_thread_id, child.updated_at
    FROM projection_threads AS child
    JOIN projection_threads AS coordinator ON coordinator.thread_id = child.parent_thread_id
    WHERE child.parent_thread_id IS NOT NULL
      AND child.parent_thread_id <> child.thread_id
      AND child.deleted_at IS NULL
      AND coordinator.deleted_at IS NULL
  `;
  const after = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fork_thread_coordinators
  `;
  return (after[0]?.count ?? 0) - (before[0]?.count ?? 0);
}).pipe(Effect.withSpan("importLegacyCoordinatorLinks"));

export const ensureForkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  // Thread orchestration: the coordinator a thread reports to where that
  // differs from its lineage; a null coordinator releases it (ThreadCoordinators.ts).
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_coordinators (
      thread_id TEXT PRIMARY KEY,
      coordinator_thread_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  // Thread orchestration: the last run of each child its coordinator heard
  // about, so a result is reported once (CoordinatorUpdates.ts).
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_reports (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      reported_at TEXT NOT NULL
    )
  `;
  // Thread orchestration: one row once the first start recorded every result
  // that already existed as reported, so switching the fork on does not wake
  // old coordinators with them (CoordinatorUpdates.ts).
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_reports_baseline (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      baselined_at TEXT NOT NULL
    )
  `;
  // Notes tab: notes and todos of a thread, a project, or the whole
  // environment (scope_id '' for global), ordered by position (ForkNotes.ts).
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_notes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      text TEXT NOT NULL,
      todo INTEGER NOT NULL,
      done INTEGER NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_notes_scope ON fork_notes (scope, scope_id)
  `;
  const imported = yield* importLegacyCoordinatorLinks;
  if (imported > 0) {
    yield* Effect.logInfo("Imported V1 coordinator links", { links: imported });
  }
}).pipe(Effect.withSpan("ensureForkSchema"));
