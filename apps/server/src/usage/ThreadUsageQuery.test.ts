import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readThreadUsage } from "./ThreadUsageQuery.ts";
import { emptySessionUsageReport, type SessionUsageInput } from "./threadSessionUsage.ts";
import { UsageService } from "./UsageService.ts";

const createdAt = "2026-09-01T10:00:00.000Z";
// Every shutdown moves last_seen_at forward, long after the transcript's last write.
const lastSeenAt = "2026-09-20T10:00:00.000Z";

const readSinceMs = (runtimePayloadJson: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('t1', 'p1', 'Thread', '{}', 'full-access', 'default', ${createdAt}, ${createdAt})`;
    yield* sql`INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES ('t1', 'claudeAgent', 'claudeAgent', 'claudeAgent', 'full-access', 'stopped',
        ${lastSeenAt}, '{"resume":"session-1"}', ${runtimePayloadJson})`;

    const asked: SessionUsageInput[] = [];
    const summary = yield* readThreadUsage({ threadId: ThreadId.make("t1") }).pipe(
      Effect.provideService(UsageService, {
        readSessionUsage: (input: SessionUsageInput) =>
          Effect.sync(() => {
            asked.push(input);
            return emptySessionUsageReport({
              status: "unavailable",
              source: "",
              fetchedAt: null,
              knownModels: 0,
            });
          }),
      } as unknown as UsageService["Service"]),
    );
    assert.isTrue(summary.matched);
    return asked[0]?.sinceMs;
  }).pipe(Effect.provide(Layer.fresh(SqlitePersistenceMemory)));

it.effect("bounds the transcript walk by the thread's creation, not its last sighting", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* readSinceMs("{}"), Date.parse(createdAt));
  }),
);

it.effect("walks every transcript for a thread with imported history", () =>
  Effect.gen(function* () {
    const sinceMs = yield* readSinceMs(
      '{"importedTranscripts":[{"providerSessionId":"imported-1"}]}',
    );
    assert.strictEqual(sinceMs, 0);
  }),
);
