// @effect-diagnostics nodeBuiltinImport:off
/* oxlint-disable unicorn/require-post-message-target-origin -- worker_threads ports take no origin. */
/**
 * Fork: runs Agent time's reads in a worker thread on a read-only connection
 * of its own. node:sqlite is synchronous and a cold month reads tens of
 * thousands of turn items for seconds; on the server's own thread that stalls
 * every request and running agent. The database runs in WAL mode, so this
 * reader never blocks the server's writes. The worker is created from source
 * text, like the whisper worker, so the single executable needs no extra
 * file. It starts with the first read and lives until the server stops.
 *
 * @module agentTimeReader
 */
import * as NodeWorkerThreads from "node:worker_threads";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
parentPort.on("message", (message) => {
  try {
    let rows = [];
    for (const row of db.prepare(message.sql).iterate(...message.params)) {
      rows.push(row);
      if (rows.length === workerData.pageSize) {
        parentPort.postMessage({ id: message.id, rows, done: false });
        rows = [];
      }
    }
    parentPort.postMessage({ id: message.id, rows, done: true });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: String(error?.message ?? error) });
  }
});
`;

// Rows come back in pages: unpacking one message blocks the server's thread,
// and a month of turn items in one message takes about 100 ms to unpack.
const PAGE_SIZE = 2_000;

type Reply =
  | { readonly id: number; readonly rows: ReadonlyArray<unknown>; readonly done: boolean }
  | { readonly id: number; readonly error: string };

export interface AgentTimeReader {
  /** Runs one read-only query off the server's thread. */
  readonly all: <Row>(
    sql: string,
    params: ReadonlyArray<string | number>,
  ) => Promise<ReadonlyArray<Row>>;
  readonly close: () => Promise<void>;
}

export function openAgentTimeReader(filename: string): AgentTimeReader {
  let worker: NodeWorkerThreads.Worker | null = null;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      readonly rows: unknown[];
      readonly resolve: (rows: ReadonlyArray<unknown>) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  const stop = () => {
    const current = worker;
    worker = null;
    return current === null ? Promise.resolve() : current.terminate().then(() => undefined);
  };

  const failAll = (error: Error) => {
    worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const start = () => {
    const created = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { filename, pageSize: PAGE_SIZE },
    });
    // Never keeps the server alive on its own.
    created.unref();
    created.on("message", (reply: Reply) => {
      const request = pending.get(reply.id);
      if (request === undefined) return;
      if ("error" in reply) {
        pending.delete(reply.id);
        request.reject(new Error(reply.error));
        return;
      }
      for (const row of reply.rows) request.rows.push(row);
      if (reply.done) {
        pending.delete(reply.id);
        request.resolve(request.rows);
      }
    });
    created.on("error", (error) => {
      if (worker === created) failAll(error);
    });
    created.on("exit", () => {
      if (worker === created) failAll(new Error("The agent time reader stopped."));
    });
    return created;
  };

  return {
    all: <Row>(sql: string, params: ReadonlyArray<string | number>) =>
      new Promise<ReadonlyArray<Row>>((resolve, reject) => {
        worker ??= start();
        const id = nextId++;
        pending.set(id, {
          rows: [],
          resolve: resolve as (rows: ReadonlyArray<unknown>) => void,
          reject,
        });
        worker.postMessage({ id, sql, params });
      }),
    close: stop,
  };
}
