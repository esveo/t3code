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
  // Peers: linked environments, the messages exchanged with them, and settings.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_peer_contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT,
      outbound_token TEXT NOT NULL,
      inbound_token_hash TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_peer_messages (
      id TEXT NOT NULL,
      direction TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      text TEXT NOT NULL,
      context TEXT,
      reply_to_id TEXT,
      thread_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, direction)
    )
  `;
  const peerMessageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(fork_peer_messages)
  `;
  if (!peerMessageColumns.some((column) => column.name === "routing_json")) {
    yield* sql`ALTER TABLE fork_peer_messages ADD COLUMN routing_json TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_peer_messages_created_at ON fork_peer_messages (created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_peer_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
  `;
}).pipe(Effect.withSpan("ensureForkSchema"));
