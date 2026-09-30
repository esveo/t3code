/**
 * Fork: a coordinator is not done while threads it coordinates are still open.
 * Upstream's automatic settlement settles a thread once all its linked pull
 * requests merged, or after days without activity; a coordinator that linked
 * its children's pull requests would settle when the last of them merged,
 * though its work goes on. The sweep leaves out every coordinator with a child
 * that is neither settled nor archived; settling it by hand still works.
 */
import type { ThreadId } from "@t3tools/contracts";
import { coordinatorThreadIdOf } from "@t3tools/shared/threadOrchestration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface OpenThreadRow {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly relationshipToParent: string | null;
  readonly creationSource: string | null;
}

/** The coordinators among `rows`' owners that still have an open thread. */
export function coordinatorsWithOpenThreads(
  openThreads: ReadonlyArray<OpenThreadRow>,
  overrides: ReadonlyMap<ThreadId, ThreadId | null>,
): ReadonlySet<ThreadId> {
  const coordinators = new Set<ThreadId>();
  for (const thread of openThreads) {
    const coordinatorId = coordinatorThreadIdOf(
      {
        id: thread.id,
        creationSource: thread.creationSource as never,
        lineage: {
          parentThreadId: thread.parentThreadId,
          relationshipToParent: thread.relationshipToParent as never,
          rootThreadId: thread.id,
        },
      },
      overrides,
    );
    if (coordinatorId !== null && coordinatorId !== thread.id) coordinators.add(coordinatorId);
  }
  return coordinators;
}

/**
 * The coordinators that must not settle automatically right now. Read fresh
 * per sweep; an empty set without a database (tests) or when the fork tables
 * are missing, so the sweep never fails on them.
 */
export const readCoordinatorsWithOpenThreads = (
  sql: SqlClient.SqlClient | null,
): Effect.Effect<ReadonlySet<ThreadId>> =>
  sql === null ? Effect.succeed(new Set<ThreadId>()) : readWith(sql);

const readWith = (sql: SqlClient.SqlClient): Effect.Effect<ReadonlySet<ThreadId>> =>
  Effect.gen(function* () {
    const links = yield* sql<{
      readonly thread_id: string;
      readonly coordinator_thread_id: string | null;
    }>`SELECT thread_id, coordinator_thread_id FROM fork_thread_coordinators`;
    const open = yield* sql<{
      readonly thread_id: string;
      readonly parent: string | null;
      readonly relationship: string | null;
      readonly source: string | null;
    }>`
    SELECT
      thread_id,
      json_extract(payload_json, '$.lineage.parentThreadId') AS parent,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
      json_extract(payload_json, '$.creationSource') AS source
    FROM orchestration_v2_projection_threads
    WHERE archived_at IS NULL
      AND deleted_at IS NULL
      AND COALESCE(json_extract(payload_json, '$.settledOverride'), '') != 'settled'
  `;
    return coordinatorsWithOpenThreads(
      open.map((row) => ({
        id: row.thread_id as ThreadId,
        parentThreadId: row.parent as ThreadId | null,
        relationshipToParent: row.relationship,
        creationSource: row.source,
      })),
      new Map(
        links.map((link) => [
          link.thread_id as ThreadId,
          link.coordinator_thread_id as ThreadId | null,
        ]),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("fork coordinator settlement guard skipped", { cause }).pipe(
        Effect.as(new Set<ThreadId>()),
      ),
    ),
  );
