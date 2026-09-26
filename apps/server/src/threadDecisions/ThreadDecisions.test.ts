import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type ThreadDecision, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Initiatives from "../initiatives/Initiatives.ts";
import { makeTestInitiatives } from "../initiatives/testFakes.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadDecisions from "./ThreadDecisions.ts";

const COORDINATOR = ThreadId.make("coordinator");

const legacyDecision = (id: string, updatedAt: string): ThreadDecision => ({
  id,
  coordinatorThreadId: COORDINATOR,
  kind: "decision",
  title: `Frage ${id}`,
  question: "Ja oder nein?",
  context: null,
  options: [{ id: "yes", label: "Ja", detail: null, pros: [], cons: [] }],
  recommendedOptionId: null,
  recommendationReason: null,
  urgency: "today",
  sourceThreadId: null,
  routeToThreadId: null,
  dependsOn: [],
  status: "open",
  answer: null,
  resolvedReason: null,
  resolvedBy: null,
  snoozedAt: null,
  askedBackAt: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt,
});

const writeLegacy = (sql: SqlClient.SqlClient, decision: ThreadDecision) =>
  sql`
    INSERT INTO fork_thread_decisions (coordinator_thread_id, decision_id, decision_json, updated_at)
    VALUES (${decision.coordinatorThreadId}, ${decision.id}, ${JSON.stringify(decision)}, ${decision.updatedAt})
    ON CONFLICT (coordinator_thread_id, decision_id)
    DO UPDATE SET decision_json = excluded.decision_json, updated_at = excluded.updated_at
  `;

const readLegacy = (sql: SqlClient.SqlClient, id: string) =>
  sql<{ readonly decision_json: string }>`
    SELECT decision_json FROM fork_thread_decisions WHERE decision_id = ${id}
  `.pipe(Effect.map((rows) => JSON.parse(rows[0]!.decision_json) as ThreadDecision));

/** The old table of one server, and a way to start ThreadDecisions on it with the initiatives. */
const makeHarness = Effect.gen(function* () {
  const persistence = yield* Layer.build(Layer.fresh(SqlitePersistenceMemory));
  const sql = Context.get(persistence, SqlClient.SqlClient);
  const { initiatives } = yield* makeTestInitiatives;
  const boot = Layer.build(
    ThreadDecisions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(persistence),
          Layer.succeed(Initiatives.Initiatives, Initiatives.Initiatives.of(initiatives)),
          Layer.mock(OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
          Layer.mock(ProjectionSnapshotQuery)({}),
          NodeServices.layer,
        ),
      ),
    ),
  ).pipe(Effect.map((context) => Context.get(context, ThreadDecisions.ThreadDecisions)));
  return { sql, initiatives, boot };
});

describe("ThreadDecisions on the initiatives' entries", () => {
  it.effect("takes the old Inbox over once and keeps the old table current", () =>
    Effect.gen(function* () {
      const { sql, initiatives, boot } = yield* makeHarness;
      yield* writeLegacy(sql, legacyDecision("a", "2026-09-20T10:00:00.000Z"));
      yield* writeLegacy(sql, legacyDecision("b", "2026-09-20T10:00:00.000Z"));

      const decisions = yield* boot;
      assert.deepEqual(
        (yield* decisions.list(COORDINATOR)).map((decision) => decision.id),
        ["a", "b"],
      );
      const entries = yield* initiatives.store.list("entry");
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.legacyKey, "inbox|coordinator|a");
      assert.equal(entries[0]?.createdBy, "import:thread-decisions");

      // A second start takes nothing over twice.
      yield* boot;
      assert.equal((yield* initiatives.store.list("entry")).length, 2);

      // Changes land in both stores, so a build without initiatives still sees them.
      yield* decisions.act(
        { type: "snooze", threadId: COORDINATOR, decisionId: "a" },
        "person:robert",
      );
      assert.isNotNull((yield* readLegacy(sql, "a")).snoozedAt);
      const snoozed = (yield* initiatives.store.list("entry")).find(
        (entry) => entry.inbox?.itemId === "a",
      );
      assert.isNotNull(snoozed?.snoozedAt);
      assert.equal(snoozed?.updatedBy, "person:robert");
    }),
  );

  it.effect("takes over what a build without initiatives changed in the meantime", () =>
    Effect.gen(function* () {
      const { sql, boot } = yield* makeHarness;
      yield* writeLegacy(sql, legacyDecision("a", "2026-09-20T10:00:00.000Z"));
      yield* boot;
      // The user answers in the old build, which writes only the old table.
      yield* writeLegacy(sql, {
        ...legacyDecision("a", "2026-09-21T10:00:00.000Z"),
        status: "answered",
        answer: { optionId: "yes", text: null },
      });
      const decisions = yield* boot;
      const [a] = yield* decisions.list(COORDINATOR);
      assert.equal(a?.status, "answered");
    }),
  );
});
