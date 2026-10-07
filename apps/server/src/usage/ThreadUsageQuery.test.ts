import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { readThreadUsage } from "./ThreadUsageQuery.ts";
import { emptySessionUsageReport, type SessionUsageInput } from "./threadSessionUsage.ts";
import { UsageService } from "./UsageService.ts";

const createdAt = "2026-09-01T10:00:00.000Z";
// Every shutdown moves last_seen_at forward, long after the transcript's last write.
const lastSeenAt = "2026-09-20T10:00:00.000Z";

const insertLegacyThread = (runtimePayloadJson: string) =>
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
  });

const insertV2ProviderThread = (input: {
  readonly id: string;
  readonly driver: string;
  readonly nativeId: string;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = `{"nativeThreadRef":{"driver":"${input.driver}","nativeId":"${input.nativeId}"}}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, provider, driver, provider_instance_id, status,
        updated_at, payload_json
      ) VALUES (${input.id}, 't1', ${input.driver}, ${input.driver}, ${input.driver}, 'idle',
        ${input.updatedAt}, ${payload})`;
  });

const insertV2Thread = (activeProviderThreadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, payload_json
      ) VALUES ('t1', 'p1', 'Thread', 'claudeAgent', 'full-access', 'default',
        ${activeProviderThreadId}, ${createdAt}, ${createdAt}, '{}')`;
  });

const readUsage = <E, R>(seed: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    yield* seed;
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
    return { summary, asked };
  }).pipe(Effect.provide(Layer.fresh(SqlitePersistenceMemory)));

it.effect("bounds the transcript walk by the thread's creation, not its last sighting", () =>
  Effect.gen(function* () {
    const { summary, asked } = yield* readUsage(insertLegacyThread("{}"));
    assert.isTrue(summary.matched);
    assert.strictEqual(asked[0]?.sinceMs, Date.parse(createdAt));
  }),
);

it.effect("walks every transcript for a thread with imported history", () =>
  Effect.gen(function* () {
    const { asked } = yield* readUsage(
      insertLegacyThread('{"importedTranscripts":[{"providerSessionId":"imported-1"}]}'),
    );
    assert.deepStrictEqual(asked[0]?.sessionIds, ["session-1", "imported-1"]);
    assert.strictEqual(asked[0]?.sinceMs, 0);
  }),
);

it.effect("reads the native sessions of a V2 thread's provider threads", () =>
  Effect.gen(function* () {
    const { summary, asked } = yield* readUsage(
      Effect.gen(function* () {
        yield* insertV2Thread("pt-codex");
        yield* insertV2ProviderThread({
          id: "pt-claude",
          driver: "claudeAgent",
          nativeId: "claude-session",
          updatedAt: lastSeenAt,
        });
        yield* insertV2ProviderThread({
          id: "pt-codex",
          driver: "codex",
          nativeId: "codex-thread",
          updatedAt: createdAt,
        });
      }),
    );
    // The active provider thread names the summary's provider.
    assert.strictEqual(summary.provider, "codex");
    assert.deepStrictEqual(
      asked.map((input) => [input.provider, input.sessionIds, input.sinceMs]),
      [
        ["codex", ["codex-thread"], Date.parse(createdAt)],
        ["claude", ["claude-session"], Date.parse(createdAt)],
      ],
    );
  }),
);

it.effect("keeps the V1 session of a thread imported into V2", () =>
  Effect.gen(function* () {
    const { asked } = yield* readUsage(
      Effect.gen(function* () {
        yield* insertLegacyThread("{}");
        yield* insertV2Thread("pt-claude");
        yield* insertV2ProviderThread({
          id: "pt-claude",
          driver: "claudeAgent",
          nativeId: "claude-v2-session",
          updatedAt: lastSeenAt,
        });
      }),
    );
    assert.deepStrictEqual(
      asked.map((input) => [input.provider, input.sessionIds]),
      [["claude", ["claude-v2-session", "session-1"]]],
    );
  }),
);
