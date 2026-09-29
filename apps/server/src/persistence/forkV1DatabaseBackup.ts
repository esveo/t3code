import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Fork: writes a consistent backup of the V1 database to
 * `<userdata>/backups/state-v1-<ISO timestamp>.sqlite` before V2 seeds itself
 * from it. Uses SQLite's online backup, so a server holding the V1 database
 * open (or uncheckpointed WAL data) still yields a complete copy.
 */
export const backupV1DatabaseBeforeV2Import = Effect.fn("backupV1DatabaseBeforeV2Import")(
  function* (sourcePath: string, now: Date = new Date()) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const backupDirectory = path.join(path.dirname(sourcePath), "backups");
    yield* fs.makeDirectory(backupDirectory, { recursive: true });
    const timestamp = now.toISOString().replaceAll(":", "-");
    const backupPath = path.join(backupDirectory, `state-v1-${timestamp}.sqlite`);
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, backupPath);
      } finally {
        database.close();
      }
      // A single self-contained file: no -wal/-shm siblings when it is opened later.
      const backup = new NodeSqlite.DatabaseSync(backupPath);
      try {
        backup.exec("PRAGMA journal_mode=DELETE");
      } finally {
        backup.close();
      }
    });
    yield* Effect.logInfo(`Backed up the V1 database before the V2 migration to ${backupPath}`);
    return backupPath;
  },
);
