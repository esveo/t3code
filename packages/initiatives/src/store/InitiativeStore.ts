/**
 * The initiatives' structured data: one SQLite table of records, keyed by kind
 * and id, and one audit table. Every change writes the record and an audit row
 * (who, when, the changed fields before and after) in one transaction, and
 * bumps the record's revision, which a caller can pass back as
 * `expectedRevision` to refuse a change made on stale data.
 *
 * The store gets its `SqlClient` as a value instead of from the context, so the
 * server can run it on a file of its own beside `state.sqlite`.
 */
import {
  type InitiativeAuthor,
  Initiative,
  InitiativeApprovalObservation,
  InitiativeAutoAssignRule,
  InitiativeBrainPage,
  InitiativeControl,
  InitiativeImportJob,
  InitiativeQuotaObservation,
  InitiativeSessionStats,
  TrimmedNonEmptyString,
  InitiativeEntry,
  InitiativeEntryLink,
  InitiativeLaunchJob,
  InitiativeProject,
  InitiativeSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What the import read from one session file, with the size and time it had:
 * a file that did not change is not read again.
 */
export const ImportCursor = Schema.Struct({
  id: TrimmedNonEmptyString,
  revision: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: Schema.String,
  updatedBy: Schema.String,
  path: TrimmedNonEmptyString,
  size: Schema.Number,
  mtimeMs: Schema.Number,
  /** The parsed session, or null for a file without one. */
  meta: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ImportCursor = typeof ImportCursor.Type;

/** What the store keeps, with how each kind is found besides its id. */
export const INITIATIVE_KINDS = {
  initiative: {
    schema: Initiative,
    initiativeId: (record: Initiative) => record.id,
    uniqueKey: (_record: Initiative): string | null => null,
  },
  project: {
    schema: InitiativeProject,
    initiativeId: (record: InitiativeProject) => record.initiativeId,
    // One initiative lists a project once; another initiative may list it too.
    uniqueKey: (record: InitiativeProject): string | null =>
      `${record.initiativeId}|${record.environmentId ?? ""}|${record.projectId ?? record.workspaceRoot}`,
  },
  session: {
    schema: InitiativeSession,
    initiativeId: (record: InitiativeSession) => record.initiativeId,
    // A session belongs to one initiative at a time.
    uniqueKey: (record: InitiativeSession): string | null => `${record.source}|${record.nativeId}`,
  },
  launchJob: {
    schema: InitiativeLaunchJob,
    initiativeId: (record: InitiativeLaunchJob) => record.initiativeId,
    uniqueKey: (record: InitiativeLaunchJob): string | null => record.key,
  },
  brainPage: {
    schema: InitiativeBrainPage,
    initiativeId: (record: InitiativeBrainPage) => record.initiativeId,
    uniqueKey: (record: InitiativeBrainPage): string | null =>
      `${record.initiativeId}|${record.path}`,
  },
  entry: {
    schema: InitiativeEntry,
    initiativeId: (record: InitiativeEntry): string | null => record.initiativeId,
    // An Inbox item is its coordinator's, under the id the coordinator chose.
    uniqueKey: (record: InitiativeEntry): string | null =>
      record.inbox ? entryInboxKey(record.inbox.threadId, record.inbox.itemId) : null,
    groupKey: (record: InitiativeEntry): string | null => record.inbox?.threadId ?? null,
  },
  link: {
    schema: InitiativeEntryLink,
    initiativeId: (record: InitiativeEntryLink): string | null => record.initiativeId,
    uniqueKey: (record: InitiativeEntryLink): string | null =>
      `${record.fromId}|${record.kind}|${record.toId}`,
  },
  observation: {
    schema: InitiativeApprovalObservation,
    initiativeId: (record: InitiativeApprovalObservation): string | null => record.initiativeId,
    // One observation per request; a restarted stream finds it again.
    uniqueKey: (record: InitiativeApprovalObservation): string | null =>
      `${record.threadId}|${record.requestId}`,
    groupKey: (record: InitiativeApprovalObservation): string | null => record.threadId,
  },
  control: {
    schema: InitiativeControl,
    initiativeId: (_record: InitiativeControl): string | null => null,
    uniqueKey: (_record: InitiativeControl): string | null => null,
  },
  importJob: {
    schema: InitiativeImportJob,
    initiativeId: (record: InitiativeImportJob): string | null => record.initiativeId,
    uniqueKey: (_record: InitiativeImportJob): string | null => null,
  },
  autoAssignRule: {
    schema: InitiativeAutoAssignRule,
    initiativeId: (record: InitiativeAutoAssignRule): string | null => record.initiativeId,
    uniqueKey: (record: InitiativeAutoAssignRule): string | null =>
      `${record.initiativeId}|${record.source}|${record.cwdPrefix}`,
  },
  importCursor: {
    schema: ImportCursor,
    initiativeId: (_record: ImportCursor): string | null => null,
    uniqueKey: (record: ImportCursor): string | null => record.path,
  },
  sessionStats: {
    schema: InitiativeSessionStats,
    initiativeId: (record: InitiativeSessionStats): string | null => record.initiativeId,
    uniqueKey: (record: InitiativeSessionStats): string | null => record.sessionId,
  },
  quotaObservation: {
    schema: InitiativeQuotaObservation,
    initiativeId: (_record: InitiativeQuotaObservation): string | null => null,
    uniqueKey: (_record: InitiativeQuotaObservation): string | null => null,
    groupKey: (record: InitiativeQuotaObservation): string | null =>
      `${record.accountId}|${record.windowId}`,
  },
} as const;

/** The unique key of an Inbox item: its coordinator thread and its id there. */
export const entryInboxKey = (threadId: string, itemId: string) => `inbox|${threadId}|${itemId}`;

export type InitiativeKind = keyof typeof INITIATIVE_KINDS;

/** Compiled once: a stored row's JSON, and a record about to be written. */
const DECODERS = {
  initiative: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(Initiative)),
    value: Schema.decodeUnknownEffect(Initiative),
  },
  project: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeProject)),
    value: Schema.decodeUnknownEffect(InitiativeProject),
  },
  session: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeSession)),
    value: Schema.decodeUnknownEffect(InitiativeSession),
  },
  launchJob: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeLaunchJob)),
    value: Schema.decodeUnknownEffect(InitiativeLaunchJob),
  },
  brainPage: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeBrainPage)),
    value: Schema.decodeUnknownEffect(InitiativeBrainPage),
  },
  entry: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeEntry)),
    value: Schema.decodeUnknownEffect(InitiativeEntry),
  },
  link: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeEntryLink)),
    value: Schema.decodeUnknownEffect(InitiativeEntryLink),
  },
  observation: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeApprovalObservation)),
    value: Schema.decodeUnknownEffect(InitiativeApprovalObservation),
  },
  control: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeControl)),
    value: Schema.decodeUnknownEffect(InitiativeControl),
  },
  importJob: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeImportJob)),
    value: Schema.decodeUnknownEffect(InitiativeImportJob),
  },
  autoAssignRule: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeAutoAssignRule)),
    value: Schema.decodeUnknownEffect(InitiativeAutoAssignRule),
  },
  importCursor: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(ImportCursor)),
    value: Schema.decodeUnknownEffect(ImportCursor),
  },
  sessionStats: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeSessionStats)),
    value: Schema.decodeUnknownEffect(InitiativeSessionStats),
  },
  quotaObservation: {
    json: Schema.decodeUnknownEffect(Schema.fromJsonString(InitiativeQuotaObservation)),
    value: Schema.decodeUnknownEffect(InitiativeQuotaObservation),
  },
} as const;
export type InitiativeRecord<K extends InitiativeKind> =
  (typeof INITIATIVE_KINDS)[K]["schema"]["Type"];

type Decoder<K extends InitiativeKind> = (
  input: unknown,
) => Effect.Effect<InitiativeRecord<K>, Schema.SchemaError>;
const decodeJson = <K extends InitiativeKind>(kind: K): Decoder<K> =>
  DECODERS[kind].json as unknown as Decoder<K>;
const decodeValue = <K extends InitiativeKind>(kind: K): Decoder<K> =>
  DECODERS[kind].value as unknown as Decoder<K>;

type BaseField = "id" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy";
export type InitiativeRecordInput<K extends InitiativeKind> = Omit<
  InitiativeRecord<K>,
  BaseField
> & {
  readonly id?: string;
};
export type InitiativeRecordPatch<K extends InitiativeKind> = Partial<
  Omit<InitiativeRecord<K>, BaseField>
>;

export class InitiativeStoreError extends Schema.TaggedError<InitiativeStoreError>()(
  "InitiativeStoreError",
  {
    reason: Schema.Literals(["notFound", "conflict", "duplicate", "failed"]),
    message: Schema.String,
  },
) {}

export interface AuditRow {
  readonly kind: InitiativeKind;
  readonly entityId: string;
  readonly revision: number;
  readonly author: InitiativeAuthor;
  readonly at: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

export interface InitiativeStore {
  readonly insert: <K extends InitiativeKind>(
    kind: K,
    input: InitiativeRecordInput<K>,
    author: InitiativeAuthor,
  ) => Effect.Effect<InitiativeRecord<K>, InitiativeStoreError>;
  readonly update: <K extends InitiativeKind>(
    kind: K,
    id: string,
    patch: InitiativeRecordPatch<K>,
    options: { readonly author: InitiativeAuthor; readonly expectedRevision?: number | undefined },
  ) => Effect.Effect<InitiativeRecord<K>, InitiativeStoreError>;
  readonly remove: <K extends InitiativeKind>(
    kind: K,
    id: string,
    author: InitiativeAuthor,
  ) => Effect.Effect<void, InitiativeStoreError>;
  readonly get: <K extends InitiativeKind>(
    kind: K,
    id: string,
  ) => Effect.Effect<Option.Option<InitiativeRecord<K>>, InitiativeStoreError>;
  readonly findByKey: <K extends InitiativeKind>(
    kind: K,
    key: string,
  ) => Effect.Effect<Option.Option<InitiativeRecord<K>>, InitiativeStoreError>;
  readonly list: <K extends InitiativeKind>(
    kind: K,
    /** initiativeId null: records of no initiative. groupKey: the kind's own grouping. */
    filter?: {
      readonly initiativeId?: string | null | undefined;
      readonly groupKey?: string | undefined;
    },
  ) => Effect.Effect<ReadonlyArray<InitiativeRecord<K>>, InitiativeStoreError>;
  readonly audit: (
    kind: InitiativeKind,
    entityId: string,
  ) => Effect.Effect<ReadonlyArray<AuditRow>, InitiativeStoreError>;
  /** Runs several writes as one: all land or none. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InitiativeStoreError, R>;
}

/** Creates the tables when missing; safe on every start. */
export const ensureInitiativeSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS initiative_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        initiative_id TEXT,
        unique_key TEXT,
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      )
    `;
    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS initiative_records_unique_key
      ON initiative_records (kind, unique_key) WHERE unique_key IS NOT NULL
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS initiative_records_by_initiative
      ON initiative_records (kind, initiative_id)
    `;
    // Added after the first builds; a database from one of those gets it here.
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(initiative_records)`;
    if (!columns.some((column) => column.name === "group_key")) {
      yield* sql`ALTER TABLE initiative_records ADD COLUMN group_key TEXT`;
    }
    yield* sql`
      CREATE INDEX IF NOT EXISTS initiative_records_by_group
      ON initiative_records (kind, group_key) WHERE group_key IS NOT NULL
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS initiative_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        author TEXT NOT NULL,
        at TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS initiative_audit_by_entity
      ON initiative_audit (kind, entity_id, seq)
    `;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new InitiativeStoreError({
          reason: "failed",
          message: `Could not prepare the store: ${cause}`,
        }),
    ),
  );

interface RecordRow {
  readonly data_json: string;
}

const failed = (detail: string) => (cause: unknown) =>
  new InitiativeStoreError({
    reason: "failed",
    message: `Could not ${detail}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** node:sqlite reports a unique violation only in the message of the error's cause. */
const isUniqueViolation = (cause: unknown): boolean => {
  for (let current = cause, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") return false;
    const error = current as {
      readonly message?: unknown;
      readonly cause?: unknown;
      readonly reason?: { readonly _tag?: string; readonly cause?: unknown };
    };
    if (error.reason?._tag === "UniqueViolation") return true;
    if (typeof error.message === "string" && /UNIQUE constraint failed/i.test(error.message)) {
      return true;
    }
    current = error.cause ?? error.reason?.cause;
  }
  return false;
};

/** The fields a patch changes, before and after. */
function diffFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  let changed = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "revision" || key === "updatedAt" || key === "updatedBy") continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
    changed = true;
  }
  return changed ? { before: changedBefore, after: changedAfter } : null;
}

export const makeInitiativeStore = (options: {
  readonly sql: SqlClient.SqlClient;
  readonly newId: Effect.Effect<string>;
}): InitiativeStore => {
  const { sql, newId } = options;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const decode = <K extends InitiativeKind>(kind: K, json: string) =>
    decodeJson(kind)(json).pipe(Effect.mapError(failed(`read a stored ${kind}`))) as Effect.Effect<
      InitiativeRecord<K>,
      InitiativeStoreError
    >;

  const decodeRows = <K extends InitiativeKind>(kind: K, rows: ReadonlyArray<RecordRow>) =>
    Effect.forEach(rows, (row) => decode(kind, row.data_json));

  /** A list skips a record it cannot read (another build's shape) and logs it, instead of failing. */
  const decodeListRows = <K extends InitiativeKind>(kind: K, rows: ReadonlyArray<RecordRow>) =>
    Effect.map(
      Effect.forEach(rows, (row) =>
        decode(kind, row.data_json).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning(`Skipped an unreadable ${kind} record`, error.message).pipe(
              Effect.as(Option.none<InitiativeRecord<K>>()),
            ),
          ),
        ),
      ),
      (records) => records.flatMap(Option.toArray),
    );

  const keysOf = <K extends InitiativeKind>(kind: K, record: InitiativeRecord<K>) => {
    const spec = INITIATIVE_KINDS[kind] as unknown as {
      readonly initiativeId: (record: InitiativeRecord<K>) => string | null;
      readonly uniqueKey: (record: InitiativeRecord<K>) => string | null;
      readonly groupKey?: (record: InitiativeRecord<K>) => string | null;
    };
    return {
      initiativeId: spec.initiativeId(record),
      uniqueKey: spec.uniqueKey(record),
      groupKey: spec.groupKey?.(record) ?? null,
    };
  };

  const writeAudit = (row: AuditRow) =>
    sql`
      INSERT INTO initiative_audit (kind, entity_id, revision, author, at, before_json, after_json)
      VALUES (${row.kind}, ${row.entityId}, ${row.revision}, ${row.author}, ${row.at},
        ${row.before === null ? null : JSON.stringify(row.before)},
        ${row.after === null ? null : JSON.stringify(row.after)})
    `;

  const getRaw = <K extends InitiativeKind>(kind: K, id: string) =>
    sql<RecordRow>`SELECT data_json FROM initiative_records WHERE kind = ${kind} AND id = ${id}`.pipe(
      Effect.mapError(failed(`read the ${kind}`)),
      Effect.flatMap((rows) => decodeRows(kind, rows)),
      Effect.map((records) => Option.fromNullishOr(records[0])),
    );

  const get: InitiativeStore["get"] = (kind, id) => getRaw(kind, id);

  const findByKey: InitiativeStore["findByKey"] = (kind, key) =>
    sql<RecordRow>`
      SELECT data_json FROM initiative_records WHERE kind = ${kind} AND unique_key = ${key}
    `.pipe(
      Effect.mapError(failed(`read the ${kind}`)),
      Effect.flatMap((rows) => decodeRows(kind, rows)),
      Effect.map((records) => Option.fromNullishOr(records[0])),
    );

  const list: InitiativeStore["list"] = (kind, filter) =>
    (filter?.groupKey !== undefined
      ? sql<RecordRow>`
          SELECT data_json FROM initiative_records
          WHERE kind = ${kind} AND group_key = ${filter.groupKey}
          ORDER BY json_extract(data_json, '$.createdAt'), id
        `
      : filter?.initiativeId === null
        ? sql<RecordRow>`
            SELECT data_json FROM initiative_records
            WHERE kind = ${kind} AND initiative_id IS NULL
            ORDER BY json_extract(data_json, '$.createdAt'), id
          `
        : filter?.initiativeId === undefined
          ? sql<RecordRow>`
              SELECT data_json FROM initiative_records WHERE kind = ${kind}
              ORDER BY json_extract(data_json, '$.createdAt'), id
            `
          : sql<RecordRow>`
              SELECT data_json FROM initiative_records
              WHERE kind = ${kind} AND initiative_id = ${filter.initiativeId}
              ORDER BY json_extract(data_json, '$.createdAt'), id
            `
    ).pipe(
      Effect.mapError(failed(`list the ${kind} records`)),
      Effect.flatMap((rows) => decodeListRows(kind, rows)),
    );

  const save = <K extends InitiativeKind>(kind: K, record: InitiativeRecord<K>, isNew: boolean) => {
    const { initiativeId, uniqueKey, groupKey } = keysOf(kind, record);
    const json = JSON.stringify(record);
    return (
      isNew
        ? sql`
            INSERT INTO initiative_records (kind, id, initiative_id, unique_key, group_key, revision, data_json, updated_at)
            VALUES (${kind}, ${record.id}, ${initiativeId}, ${uniqueKey}, ${groupKey}, ${record.revision}, ${json}, ${record.updatedAt})
          `
        : sql`
            UPDATE initiative_records
            SET initiative_id = ${initiativeId}, unique_key = ${uniqueKey}, group_key = ${groupKey},
              revision = ${record.revision}, data_json = ${json}, updated_at = ${record.updatedAt}
            WHERE kind = ${kind} AND id = ${record.id}
          `
    ).pipe(
      Effect.mapError((cause) =>
        isUniqueViolation(cause)
          ? new InitiativeStoreError({
              reason: "duplicate",
              message: `This ${kind} exists already.`,
            })
          : failed(`save the ${kind}`)(cause),
      ),
    );
  };

  const transaction: InitiativeStore["transaction"] = (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) => Effect.fail(failed("finish the change")(cause))),
      ) as never;

  const insert: InitiativeStore["insert"] = (kind, input, author) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* nowIso;
        const id = input.id ?? (yield* newId);
        const record = yield* decodeValue(kind)({
          ...input,
          id,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: author,
          updatedBy: author,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new InitiativeStoreError({
                reason: "failed",
                message: `Invalid ${kind}: ${cause.message}`,
              }),
          ),
        );
        const typed = record as InitiativeRecord<typeof kind>;
        yield* save(kind, typed, true);
        yield* writeAudit({
          kind,
          entityId: id,
          revision: 1,
          author,
          at,
          before: null,
          after: record as unknown as Record<string, unknown>,
        }).pipe(Effect.mapError(failed("write the audit row")));
        return typed;
      }),
    );

  const update: InitiativeStore["update"] = (kind, id, patch, { author, expectedRevision }) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* getRaw(kind, id);
        if (Option.isNone(current)) {
          return yield* new InitiativeStoreError({
            reason: "notFound",
            message: `No ${kind} ${id}.`,
          });
        }
        const before = current.value;
        if (expectedRevision !== undefined && expectedRevision !== before.revision) {
          return yield* new InitiativeStoreError({
            reason: "conflict",
            message: `The ${kind} changed in the meantime (revision ${before.revision}, not ${expectedRevision}). Reload and try again.`,
          });
        }
        const at = yield* nowIso;
        const merged = {
          ...before,
          ...patch,
          id: before.id,
          createdAt: before.createdAt,
          createdBy: before.createdBy,
        };
        const changes = diffFields(
          before as unknown as Record<string, unknown>,
          merged as unknown as Record<string, unknown>,
        );
        if (changes === null) return before;
        const record = yield* decodeValue(kind)({
          ...merged,
          revision: before.revision + 1,
          updatedAt: at,
          updatedBy: author,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new InitiativeStoreError({
                reason: "failed",
                message: `Invalid ${kind}: ${cause.message}`,
              }),
          ),
        );
        const typed = record as InitiativeRecord<typeof kind>;
        yield* save(kind, typed, false);
        yield* writeAudit({
          kind,
          entityId: id,
          revision: typed.revision,
          author,
          at,
          before: changes.before,
          after: changes.after,
        }).pipe(Effect.mapError(failed("write the audit row")));
        return typed;
      }),
    );

  const remove: InitiativeStore["remove"] = (kind, id, author) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* getRaw(kind, id);
        if (Option.isNone(current)) return;
        yield* sql`DELETE FROM initiative_records WHERE kind = ${kind} AND id = ${id}`.pipe(
          Effect.mapError(failed(`remove the ${kind}`)),
        );
        yield* writeAudit({
          kind,
          entityId: id,
          revision: current.value.revision + 1,
          author,
          at: yield* nowIso,
          before: current.value as unknown as Record<string, unknown>,
          after: null,
        }).pipe(Effect.mapError(failed("write the audit row")));
      }),
    );

  const audit: InitiativeStore["audit"] = (kind, entityId) =>
    sql<{
      readonly revision: number;
      readonly author: string;
      readonly at: string;
      readonly before_json: string | null;
      readonly after_json: string | null;
    }>`
      SELECT revision, author, at, before_json, after_json FROM initiative_audit
      WHERE kind = ${kind} AND entity_id = ${entityId} ORDER BY seq
    `.pipe(
      Effect.mapError(failed("read the audit rows")),
      Effect.map((rows) =>
        rows.map((row): AuditRow => ({
          kind,
          entityId,
          revision: row.revision,
          author: row.author,
          at: row.at,
          before: row.before_json === null ? null : JSON.parse(row.before_json),
          after: row.after_json === null ? null : JSON.parse(row.after_json),
        })),
      ),
    );

  return { insert, update, remove, get, findByKey, list, audit, transaction };
};
