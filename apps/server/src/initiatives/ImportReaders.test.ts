// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ensureInitiativeSchema, makeInitiativeStore } from "@t3tools/initiatives/store";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeImportReaders } from "./ImportReaders.ts";
import { makeFakeBridge } from "./testFakes.ts";

/** A home folder with one Claude Code transcript and a Codex index of one thread. */
const makeHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-import-home-"));
  const project = NodePath.join(home, ".claude", "projects", "-Users-robert-dev-relaunch");
  NodeFS.mkdirSync(NodePath.join(project, "s1", "subagents"), { recursive: true });
  const record = (fields: Record<string, unknown>) => JSON.stringify(fields);
  NodeFS.writeFileSync(
    NodePath.join(project, "s1.jsonl"),
    [
      record({
        type: "user",
        sessionId: "s1",
        cwd: "/Users/robert/dev/relaunch",
        entrypoint: "cli",
        timestamp: "2026-09-20T10:00:00.000Z",
        message: { role: "user", content: "Bau die Startseite" },
      }),
      record({
        type: "assistant",
        sessionId: "s1",
        cwd: "/Users/robert/dev/relaunch",
        timestamp: "2026-09-20T10:30:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Erledigt." }] },
      }),
    ].join("\n"),
  );
  // A subagent's transcript is no session of its own.
  NodeFS.writeFileSync(NodePath.join(project, "s1", "subagents", "agent.jsonl"), "{}");
  NodeFS.mkdirSync(NodePath.join(home, ".codex"), { recursive: true });
  const rollout = NodePath.join(home, ".codex", "rollout.jsonl");
  NodeFS.writeFileSync(
    rollout,
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Build ist grün." },
    }),
  );
  const codex = new NodeSqlite.DatabaseSync(NodePath.join(home, ".codex", "state_5.sqlite"));
  codex.exec(
    "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, first_user_message TEXT, git_branch TEXT, model TEXT, tokens_used INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
  );
  codex
    .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "c1",
      rollout,
      "/Users/robert/dev/relaunch",
      "",
      "Fix the build",
      "main",
      "gpt-6",
      1200,
      1_758_000_000_000,
      1_758_000_600_000,
    );
  codex.close();
  return home;
};

const makeReaders = Effect.gen(function* () {
  const initiatives = Context.get(
    yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" })),
    SqlClient.SqlClient,
  );
  yield* ensureInitiativeSchema(initiatives);
  let counter = 0;
  const store = makeInitiativeStore({
    sql: initiatives,
    newId: Effect.sync(() => `id-${++counter}`),
  });
  const mainSql = Context.get(
    yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" })),
    SqlClient.SqlClient,
  );
  yield* mainSql`CREATE TABLE provider_session_runtime (resume_cursor_json TEXT)`;
  yield* mainSql`INSERT INTO provider_session_runtime VALUES (${'{"resume":"s-from-t3"}'})`;
  const home = makeHome();
  const readers = yield* makeImportReaders({
    store,
    bridge: makeFakeBridge().bridge,
    mainSql,
    homeDir: home,
  });
  return { readers, store };
});

describe("import readers", () => {
  it.effect("read Claude Code and Codex sessions of this machine, read-only", () =>
    Effect.gen(function* () {
      const { readers, store } = yield* makeReaders;
      const claude = yield* readers.claude;
      assert.deepEqual(
        claude.map((session) => [session.source, session.nativeId, session.cwd, session.title]),
        [["claude-code-cli", "s1", "/Users/robert/dev/relaunch", "Bau die Startseite"]],
      );
      // The file did not change, so the second scan reads the cursor instead.
      assert.equal((yield* store.list("importCursor")).length, 1);
      yield* readers.claude;
      assert.equal((yield* store.list("importCursor"))[0]?.revision, 1);

      const codex = yield* readers.codex;
      assert.deepInclude(codex[0], {
        source: "codex",
        nativeId: "c1",
        title: "Fix the build",
        tokens: 1200,
      });
      assert.include((yield* readers.excerpt("codex", "c1")) ?? "", "Build ist grün.");
      assert.include((yield* readers.excerpt("claude-code-cli", "s1")) ?? "", "Agent: Erledigt.");
      assert.isTrue((yield* readers.t3NativeIds).has("s-from-t3"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
