import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { readCoordinatorsWithOpenThreads } from "./forkSettlementGuard.ts";

const insertThread = (
  sql: SqlClient.SqlClient,
  id: string,
  payload: Record<string, unknown>,
  archivedAt: string | null = null,
) => sql`
  INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
     created_at, updated_at, archived_at, payload_json)
  VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default',
          '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z', ${archivedAt}, ${JSON.stringify(payload)})
`;

const delegated = (parent: string) => ({
  creationSource: "mcp",
  lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
});

it.effect("keeps a coordinator with an open thread out of automatic settlement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // An open delegated child keeps its starter active.
    yield* insertThread(sql, "busy", {});
    yield* insertThread(sql, "busy-child", delegated("busy"));
    // Settled and archived children do not.
    yield* insertThread(sql, "done", {});
    yield* insertThread(sql, "done-settled", { ...delegated("done"), settledOverride: "settled" });
    yield* insertThread(sql, "done-archived", delegated("done"), "2026-09-30T01:00:00Z");
    // An adopted thread counts for its coordinator, and a moved child no longer for its starter.
    yield* insertThread(sql, "adopter", {});
    yield* insertThread(sql, "adopted", {});
    yield* insertThread(sql, "moved", delegated("done"));
    yield* sql`INSERT INTO fork_thread_coordinators (thread_id, coordinator_thread_id, updated_at)
      VALUES ('adopted', 'adopter', '2026-09-30T00:00:00Z'),
             ('moved', 'adopter', '2026-09-30T00:00:00Z')`;
    // A provider's own subagent never makes its parent a coordinator.
    yield* insertThread(sql, "native-parent", {});
    yield* insertThread(sql, "native", {
      ...delegated("native-parent"),
      creationSource: "provider",
    });

    const open = yield* readCoordinatorsWithOpenThreads(sql);
    assert.deepEqual([...open].sort(), ["adopter", "busy"]);
    assert.strictEqual((yield* readCoordinatorsWithOpenThreads(null)).size, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
