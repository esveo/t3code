import { assert, describe, it } from "@effect/vitest";
import type { ImportedSessionMeta } from "@t3tools/initiatives/importers";
import { ensureInitiativeSchema, makeInitiativeStore } from "@t3tools/initiatives/store";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeInitiativeImport } from "./InitiativeImport.ts";
import { makeFakeReaders } from "./testFakes.ts";

const ROBERT = "person:robert";
const REPO = "/Users/robert/dev/relaunch";

const claudeSession = (index: number, cwd = REPO): ImportedSessionMeta => ({
  source: "claude-code-cli",
  nativeId: `claude-${index}`,
  cwd,
  title: `Session ${index}`,
  startedAt: `2026-09-${String(10 + (index % 10)).padStart(2, "0")}T10:00:00.000Z`,
  endedAt: null,
  branch: "main",
  prUrls: [],
  model: "claude-opus",
  tokens: null,
});

/** The import over an in-memory store, with jobs that run only when the test runs them. */
const makeHarness = Effect.gen(function* () {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* ensureInitiativeSchema(sql);
  let counter = 0;
  const store = makeInitiativeStore({ sql, newId: Effect.sync(() => `id-${++counter}`) });
  const fake = makeFakeReaders();
  const queued: Array<Effect.Effect<void>> = [];
  const importer = makeInitiativeImport({
    store,
    readers: fake.readers,
    summarize: fake.summarize,
    changed: () => Effect.void,
    environmentId: null,
    fork: (effect) => Effect.sync(() => void queued.push(effect)),
  });
  const runQueued = Effect.suspend(() => {
    const next = queued.splice(0);
    return Effect.forEach(next, (effect) => effect, { discard: true });
  });
  const initiative = yield* store.insert(
    "initiative",
    {
      title: "Relaunch",
      goalText: "",
      status: "active",
      instructionsMd: "",
      homeEnvironmentId: null,
      providerExclusions: [],
      coordinatorThreadId: null,
      halted: false,
      preflightMode: "shadow",
    },
    ROBERT,
  );
  yield* store.insert(
    "project",
    {
      initiativeId: initiative.id,
      environmentId: null,
      projectId: null,
      workspaceRoot: REPO,
      label: "Relaunch",
    },
    ROBERT,
  );
  return { store, importer, fake, runQueued, initiativeId: initiative.id };
});

describe("initiative import", () => {
  it.effect(
    "lists folders with the initiative's own preselected, and leaves out T3's own runs",
    () =>
      Effect.gen(function* () {
        const { importer, fake, initiativeId } = yield* makeHarness;
        fake.sessions.claude.push(
          claudeSession(1),
          claudeSession(2),
          claudeSession(3, "/Users/robert/other"),
        );
        fake.t3NativeIds.add("claude-2");
        const catalog = yield* importer.catalog(initiativeId);
        const own = catalog.groups.find((group) => group.cwd === REPO)!;
        assert.deepInclude(own, {
          source: "claude-code-cli",
          count: 1,
          preselected: true,
          imported: 0,
        });
        assert.isFalse(
          catalog.groups.find((group) => group.cwd === "/Users/robert/other")!.preselected,
        );
      }),
  );

  it.effect("imports each session once, pauses and resumes where it stopped", () =>
    Effect.gen(function* () {
      const { store, importer, fake, runQueued, initiativeId } = yield* makeHarness;
      for (let index = 0; index < 60; index += 1) fake.sessions.claude.push(claudeSession(index));
      const job = yield* importer.run(
        initiativeId,
        [{ source: "claude-code-cli", cwd: REPO }],
        false,
        ROBERT,
      );
      yield* importer.control(job.id, "pause", ROBERT);
      yield* runQueued;
      const paused = Option.getOrThrow(yield* store.get("importJob", job.id));
      assert.equal(paused.status, "paused");
      assert.equal(paused.cursor, 25);
      assert.equal((yield* store.list("session", { initiativeId })).length, 25);

      yield* importer.control(job.id, "resume", ROBERT);
      yield* runQueued;
      const done = Option.getOrThrow(yield* store.get("importJob", job.id));
      assert.deepInclude(done, { status: "done", done: 60, added: 60, skipped: 0 });
      assert.equal((yield* store.list("session", { initiativeId })).length, 60);

      // A second import adds nothing.
      const again = yield* importer.run(
        initiativeId,
        [{ source: "claude-code-cli", cwd: REPO }],
        false,
        ROBERT,
      );
      yield* runQueued;
      assert.deepInclude(Option.getOrThrow(yield* store.get("importJob", again.id)), {
        status: "done",
        added: 0,
        skipped: 60,
      });
      assert.equal((yield* store.list("session", { initiativeId })).length, 60);
      assert.equal((yield* importer.catalog(initiativeId)).groups[0]?.imported, 60);
    }),
  );

  it.effect("summarizes on request until the cost cap, and takes imports out again", () =>
    Effect.gen(function* () {
      const { store, importer, fake, runQueued, initiativeId } = yield* makeHarness;
      fake.sessions.claude.push(claudeSession(1), claudeSession(2), claudeSession(3));
      for (const id of ["claude-1", "claude-2", "claude-3"]) {
        fake.excerpts.set(
          id,
          "User: bau die Startseite\n\nAgent: Fertig, PR #4 ist offen. token=abc",
        );
      }
      yield* importer.run(initiativeId, [{ source: "claude-code-cli", cwd: REPO }], false, ROBERT);
      yield* runQueued;
      const sessions = yield* store.list("session", { initiativeId });
      const job = yield* importer.summarizeSessions(
        initiativeId,
        sessions.map((session) => session.id),
        0.015,
        ROBERT,
      );
      yield* runQueued;
      const stopped = Option.getOrThrow(yield* store.get("importJob", job.id));
      assert.equal(stopped.status, "paused");
      assert.include(stopped.error ?? "", "cost cap");
      assert.equal(fake.state.summaries, 2);
      const summarized = (yield* store.list("session", { initiativeId })).filter(
        (session) => session.summary,
      );
      assert.equal(summarized.length, 2);

      const removed = yield* importer.remove(initiativeId, "claude-code-cli", REPO, ROBERT);
      assert.equal(removed, 3);
      assert.equal((yield* store.list("session", { initiativeId })).length, 0);
    }),
  );

  it.effect("assigns new sessions of a remembered folder on its own, until the rule is off", () =>
    Effect.gen(function* () {
      const { store, importer, fake, runQueued, initiativeId } = yield* makeHarness;
      fake.sessions.claude.push(claudeSession(1));
      yield* importer.run(initiativeId, [{ source: "claude-code-cli", cwd: REPO }], true, ROBERT);
      yield* runQueued;
      fake.sessions.claude.push(claudeSession(2));
      assert.equal(yield* importer.applyAutoAssign, 1);
      const added = (yield* store.list("session", { initiativeId })).find(
        (session) => session.nativeId === "claude-2",
      );
      assert.equal(added?.assignment, "auto");

      const [rule] = yield* store.list("autoAssignRule", { initiativeId });
      yield* store.update("autoAssignRule", rule!.id, { enabled: false }, { author: ROBERT });
      fake.sessions.claude.push(claudeSession(3));
      assert.equal(yield* importer.applyAutoAssign, 0);
    }),
  );
});
