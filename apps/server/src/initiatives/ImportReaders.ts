// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: the import's readers of this machine's earlier sessions, read-only.
 * Claude Code keeps a JSONL transcript per session under ~/.claude/projects;
 * a file that kept its size and time is not read again (its parse is stored
 * as an import cursor). Codex keeps an index in ~/.codex/state_5.sqlite,
 * opened read-only. T3's own threads come from the projection, and the
 * provider session ids they ran from `provider_session_runtime`.
 */
import * as NodeOS from "node:os";

import { type InitiativeImportSource, InitiativesError, type ThreadId } from "@t3tools/contracts";
import type { ThreadBridge } from "@t3tools/initiatives/bridge";
import {
  claudeTranscriptExcerpt,
  codexSessionMeta,
  type CodexThreadRow,
  codexTranscriptExcerpt,
  type ImportedSessionMeta,
  makeClaudeMetaReader,
} from "@t3tools/initiatives/importers";
import type { InitiativeStore } from "@t3tools/initiatives/store";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resumeSessionIds } from "../usage/threadSessionUsage.ts";
import type { ImportReaders } from "./InitiativeImport.ts";

const failure = (message: string) => new InitiativesError({ message });

/** Transcripts larger than this are skipped for summaries; their metadata still counts. */
const EXCERPT_FILE_LIMIT = 64 * 1024 * 1024;

export const makeImportReaders = Effect.fn("makeImportReaders")(function* (input: {
  readonly store: InitiativeStore;
  readonly bridge: ThreadBridge;
  readonly mainSql: SqlClient.SqlClient;
  readonly homeDir?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = input.homeDir ?? NodeOS.homedir();
  const claudeRoot = path.join(home, ".claude", "projects");
  const codexIndex = path.join(home, ".codex", "state_5.sqlite");
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const readLines = (file: string, onLine: (line: string) => void) =>
    fs.stream(file).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => onLine(line))),
    );

  /** The session files of Claude Code: one per session, beside the folder of its subagents. */
  const claudeFiles = Effect.gen(function* () {
    if (!(yield* exists(claudeRoot))) return [];
    const projects = yield* fs.readDirectory(claudeRoot).pipe(Effect.orElseSucceed(() => []));
    const files: Array<string> = [];
    for (const project of projects) {
      const dir = path.join(claudeRoot, project);
      const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
    }
    return files;
  });

  /** One file's session, from its cursor when size and time did not change. */
  const claudeMetaOf = (file: string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info)) return null;
      const size = Number(info.value.size);
      const mtimeMs = Option.match(info.value.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      const cursor = Option.getOrNull(
        yield* input.store
          .findByKey("importCursor", file)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (cursor && cursor.size === size && cursor.mtimeMs === mtimeMs) {
        return (cursor.meta as ImportedSessionMeta | null) ?? null;
      }
      const reader = makeClaudeMetaReader(path.basename(file, ".jsonl"));
      yield* readLines(file, reader.push).pipe(Effect.ignore);
      const meta = reader.finish();
      const record = {
        path: file,
        size,
        mtimeMs,
        meta: meta as unknown as Record<string, unknown> | null,
      };
      yield* (
        cursor
          ? input.store.update("importCursor", cursor.id, record, { author: "system:import" })
          : input.store.insert("importCursor", record, "system:import")
      ).pipe(Effect.ignore);
      return meta;
    });

  const claude = Effect.gen(function* () {
    const files = yield* claudeFiles;
    const metas = yield* Effect.forEach(files, claudeMetaOf, { concurrency: 4 });
    return metas.filter((meta): meta is ImportedSessionMeta => meta !== null);
  }).pipe(Effect.mapError(() => failure("Could not read the Claude Code sessions.")));

  /** Codex's index, opened read-only for the time of one query. */
  const withCodexIndex = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          NodeSqliteClient.layer({ filename: codexIndex, readonly: true }),
        );
        return yield* use(Context.get(context, SqlClient.SqlClient));
      }),
    );

  const codex = Effect.gen(function* () {
    if (!(yield* exists(codexIndex))) return [];
    const rows = yield* withCodexIndex(
      (sql) =>
        sql<CodexThreadRow>`
        SELECT id, cwd, title, first_user_message, git_branch, model, tokens_used, created_at_ms, updated_at_ms
        FROM threads
      `,
    );
    return rows.map(codexSessionMeta);
  }).pipe(Effect.mapError(() => failure("Could not read the Codex sessions.")));

  const t3 = Effect.gen(function* () {
    const [threads, projects] = yield* Effect.all([
      input.bridge.listThreads(),
      input.bridge.listProjects(),
    ]);
    const roots = new Map(projects.map((project) => [project.projectId, project.workspaceRoot]));
    return threads.map((thread) => ({
      source: "t3" as const,
      nativeId: thread.id,
      threadId: thread.id as ThreadId,
      cwd: thread.worktreePath ?? roots.get(thread.projectId) ?? null,
      title: thread.title,
      startedAt: thread.createdAt,
      endedAt: thread.updatedAt,
      branch: thread.branch,
      prUrls: thread.pullRequests.map((pullRequest) => pullRequest.url),
      model: thread.modelSelection.model,
      tokens: null,
    }));
  }).pipe(Effect.orElseSucceed(() => []));

  const t3NativeIds = input.mainSql<{ readonly resumeCursor: string | null }>`
    SELECT resume_cursor_json AS "resumeCursor" FROM provider_session_runtime
  `.pipe(
    Effect.map((rows) => {
      const ids = new Set<string>();
      for (const row of rows) {
        if (!row.resumeCursor) continue;
        let cursor: unknown;
        try {
          cursor = JSON.parse(row.resumeCursor);
        } catch {
          continue;
        }
        for (const id of [
          ...resumeSessionIds(cursor, "claude"),
          ...resumeSessionIds(cursor, "codex"),
        ]) {
          ids.add(id);
        }
      }
      return ids as ReadonlySet<string>;
    }),
    Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
  );

  const excerptOfFile = (file: string, excerpt: (lines: Iterable<string>) => string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || Number(info.value.size) > EXCERPT_FILE_LIMIT) return null;
      const lines: Array<string> = [];
      yield* readLines(file, (line) => lines.push(line));
      return excerpt(lines) || null;
    });

  const excerpt: ImportReaders["excerpt"] = (source, nativeId) =>
    Effect.gen(function* () {
      if (source === "codex") {
        if (!(yield* exists(codexIndex))) return null;
        const rows = yield* withCodexIndex(
          (sql) =>
            sql<{ readonly rollout_path: string | null }>`
            SELECT rollout_path FROM threads WHERE id = ${nativeId}
          `,
        );
        const file = rows[0]?.rollout_path;
        return file ? yield* excerptOfFile(file, codexTranscriptExcerpt) : null;
      }
      if (source === "t3") return null;
      // The cursor of the file that holds the session.
      const cursors = yield* input.store.list("importCursor");
      const cursor = cursors.find((candidate) => candidate.meta?.["nativeId"] === nativeId);
      return cursor ? yield* excerptOfFile(cursor.path, claudeTranscriptExcerpt) : null;
    }).pipe(Effect.mapError(() => failure(`Could not read the session ${nativeId}.`)));

  const available = Effect.gen(function* () {
    const hasClaude = yield* exists(claudeRoot);
    return {
      t3: true,
      "claude-code-cli": hasClaude,
      "claude-desktop": hasClaude,
      codex: yield* exists(codexIndex),
    } satisfies Record<InitiativeImportSource, boolean>;
  });

  return { claude, codex, t3, t3NativeIds, excerpt, available } satisfies ImportReaders;
});
