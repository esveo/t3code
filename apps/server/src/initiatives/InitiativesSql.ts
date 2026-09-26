/**
 * Fork: the initiatives' own database, `initiatives.sqlite` beside
 * `state.sqlite`. It is a separate file so upstream's migrator never sees the
 * fork's tables and a V2 migration of `state.sqlite` leaves it alone. The
 * client lives under its own tag so it never replaces the main `SqlClient`.
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";

export class InitiativesSql extends Context.Service<InitiativesSql, SqlClient.SqlClient>()(
  "t3/initiatives/InitiativesSql",
) {}

const open = (filename: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      NodeSqliteClient.layer({
        filename,
        spanAttributes: { "db.name": "initiatives.sqlite", "service.name": "t3-server" },
      }),
    );
    return Context.get(context, SqlClient.SqlClient);
  });

export const layer = Layer.effect(
  InitiativesSql,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    return yield* open(path.join(stateDir, "initiatives.sqlite"));
  }),
);

export const layerMemory = Layer.effect(InitiativesSql, open(":memory:"));
