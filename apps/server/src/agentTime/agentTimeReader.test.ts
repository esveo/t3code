// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterAll, describe, expect, it } from "@effect/vitest";

import { openAgentTimeReader } from "./agentTimeReader.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-time-reader-"));
const filename = NodePath.join(dir, "state.sqlite");
const db = new NodeSqlite.DatabaseSync(filename);
db.exec("PRAGMA journal_mode = WAL");
db.exec("CREATE TABLE runs (id TEXT, provider TEXT)");
db.exec("INSERT INTO runs VALUES ('a', 'claudeAgent'), ('b', 'codex'), ('c', 'claudeAgent')");

afterAll(() => {
  db.close();
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("openAgentTimeReader", () => {
  it("reads on a worker while the server's connection stays open, and reports errors", async () => {
    const reader = openAgentTimeReader(filename);
    try {
      const rows = await reader.all<{ id: string }>(
        "SELECT id FROM runs WHERE provider = ? ORDER BY id",
        ["claudeAgent"],
      );
      expect(rows).toEqual([{ id: "a" }, { id: "c" }]);
      await expect(reader.all("SELECT * FROM missing", [])).rejects.toThrow(/no such table/);
      // Read-only: the worker cannot change the server's data.
      await expect(reader.all("DELETE FROM runs", [])).rejects.toThrow(/readonly/);
      // Still usable after a failed query.
      expect(await reader.all("SELECT count(*) AS n FROM runs", [])).toEqual([{ n: 3 }]);
      // Large answers arrive in pages and come back whole and in order.
      const many = await reader.all<{ n: number }>(
        "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?) SELECT n FROM seq",
        [4_500],
      );
      expect(many.length).toBe(4_500);
      expect(many.every((row, index) => row.n === index + 1)).toBe(true);
    } finally {
      await reader.close();
    }
  });
});
