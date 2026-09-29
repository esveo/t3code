// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { initializeV2Database } from "./initializeV2Database.ts";

const backupFiles = (userdata: string) => {
  const directory = NodePath.join(userdata, "backups");
  return NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory) : [];
};

it.effect("backs up an open V1 database once, before the first V2 import", () => {
  const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-v1-backup-"));
  const sourcePath = NodePath.join(userdata, "state.sqlite");
  const destinationPath = NodePath.join(userdata, "statev2.sqlite");
  return Effect.gen(function* () {
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('v1 work');",
      );
      yield* initializeV2Database(destinationPath);
    } finally {
      source.close();
    }

    const backups = backupFiles(userdata);
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, /^state-v1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sqlite$/);
    const backup = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "backups", backups[0]!), {
      readOnly: true,
    });
    try {
      assert.deepEqual(
        backup
          .prepare("SELECT text FROM messages")
          .all()
          .map((row) => row.text),
        ["v1 work"],
      );
    } finally {
      backup.close();
    }

    // V2 exists now: later starts neither import nor back up again.
    yield* initializeV2Database(destinationPath);
    assert.equal(backupFiles(userdata).length, 1);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(userdata, { recursive: true, force: true }))),
  );
});

it.effect("writes no backup when there is no V1 database", () => {
  const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-v1-backup-"));
  return Effect.gen(function* () {
    yield* initializeV2Database(NodePath.join(userdata, "statev2.sqlite"));
    assert.deepEqual(backupFiles(userdata), []);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(userdata, { recursive: true, force: true }))),
  );
});
