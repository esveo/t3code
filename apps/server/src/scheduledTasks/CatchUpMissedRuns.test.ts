import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const localAt = (day: number, hour: number) =>
  DateTime.makeZonedUnsafe(
    { year: 2026, month: 10, day, hour, minute: 0, second: 0, millisecond: 0 },
    { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
  );
const isoAt = (day: number, hour: number) => DateTime.formatIso(DateTime.toUtc(localAt(day, hour)));

it.effect("catches up a missed fixed-time run once only when the task opts in", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = isoAt(5, 12);
    const rows = [
      // Missed three daily slots (Oct 2 to Oct 4) and today's: skipped as upstream does.
      { id: "skip", next: isoAt(2, 9), schedule: '{"type":"fixed_time","timeOfDay":"09:00"}' },
      // Missed Oct 3, Oct 4 and today's slot: runs exactly once.
      {
        id: "catch-up",
        next: isoAt(3, 9),
        schedule: '{"type":"fixed_time","timeOfDay":"09:00","catchUpMissedRuns":true}',
      },
      // Sorts last; its dispatch is the receipt that both tasks above settled.
      { id: "receipt", next: isoAt(5, 11), schedule: '{"type":"interval","everyMs":3600000}' },
    ];
    for (const row of rows) {
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: row.id,
        title: row.id,
        prompt: "Run task",
        enabled: 1,
        schedule_json: row.schedule,
        project_id: "project:test",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: now,
        updated_at: now,
        next_run_at: row.next,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
    }
    yield* TestClock.setTime(Date.parse(now));

    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    const receiptLaunched = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          Layer.provideMerge(
            ScheduledTaskService.layer,
            Layer.mergeAll(
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: (input) =>
                  Ref.update(launched, (ids) => [...ids, input.title]).pipe(
                    Effect.andThen(
                      input.title === "receipt"
                        ? Deferred.succeed(receiptLaunched, undefined)
                        : Effect.void,
                    ),
                    Effect.andThen(Effect.die(new Error("test launch"))),
                  ),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              NodeCrypto.layer,
              Scheduler.layer,
            ),
          ),
        );
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(receiptLaunched);
      }),
    );

    assert.deepEqual(yield* Ref.get(launched), ["catch-up", "receipt"]);
    const settled = yield* sql<{
      task_id: string;
      next_run_at: string | null;
      run_count: number;
    }>`SELECT task_id, next_run_at, run_count FROM scheduled_tasks ORDER BY task_id`;
    const byId = new Map(settled.map((row) => [row.task_id, row]));
    assert.equal(byId.get("catch-up")?.run_count, 1);
    assert.equal(byId.get("catch-up")?.next_run_at, isoAt(6, 9));
    assert.equal(byId.get("skip")?.run_count, 0);
    assert.equal(byId.get("skip")?.next_run_at, isoAt(6, 9));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
