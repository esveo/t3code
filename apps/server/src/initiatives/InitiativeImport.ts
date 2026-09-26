/**
 * Fork: the import of earlier work into an initiative. The catalog lists the
 * sessions of each source per folder; an import job takes the metadata of
 * the chosen folders over, one session per native id, never one another
 * initiative holds, and never a Claude or Codex session a T3 thread already
 * ran. Summaries come later, on request, within a cost cap. Jobs keep a
 * cursor: paused, cancelled or cut off by a restart, they continue where they
 * stopped. Nothing is imported without a selection.
 */
import {
  type EnvironmentId,
  type InitiativeAuthor,
  type InitiativeImportCatalog,
  type InitiativeImportJob,
  type InitiativeImportSelection,
  type InitiativeImportSource,
  type InitiativeSession,
  InitiativesError,
  ThreadId,
} from "@t3tools/contracts";
import {
  groupSessions,
  type ImportedSessionMeta,
  isUnder,
  summaryPrompt,
} from "@t3tools/initiatives/importers";
import type { InitiativeStore } from "@t3tools/initiatives/store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const failure = (message: string) => new InitiativesError({ message });

/** Where the import reads from; the server's readers touch the local files, tests fake them. */
export interface ImportReaders {
  readonly claude: Effect.Effect<ReadonlyArray<ImportedSessionMeta>, InitiativesError>;
  readonly codex: Effect.Effect<ReadonlyArray<ImportedSessionMeta>, InitiativesError>;
  readonly t3: Effect.Effect<ReadonlyArray<ImportedSessionMeta & { readonly threadId: ThreadId }>>;
  /** Provider session ids T3 threads ran, so their transcripts are not imported twice. */
  readonly t3NativeIds: Effect.Effect<ReadonlySet<string>>;
  /** A masked excerpt of an imported session, for its summary. */
  readonly excerpt: (
    source: InitiativeImportSource,
    nativeId: string,
  ) => Effect.Effect<string | null, InitiativesError>;
  readonly available: Effect.Effect<Record<InitiativeImportSource, boolean>>;
}

export type Summarize = (
  prompt: string,
) => Effect.Effect<{ readonly text: string; readonly costUsd: number }, InitiativesError>;

/** Progress is saved this often, and pause or cancel are checked as often. */
const PROGRESS_EVERY = 25;

const SOURCE_NOTES: Record<InitiativeImportSource, string> = {
  t3: "Threads dieses Servers",
  "claude-code-cli": "Claude Code im Terminal (~/.claude/projects)",
  "claude-desktop": "Claude Code in der Desktop-App (~/.claude/projects)",
  codex: "Codex (~/.codex)",
};

export const makeInitiativeImport = (options: {
  readonly store: InitiativeStore;
  readonly readers: ImportReaders;
  readonly summarize: Summarize;
  readonly changed: (initiativeId: string | null) => Effect.Effect<unknown>;
  readonly environmentId: EnvironmentId | null;
  /** Runs a job in the background, beyond the request that started it. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}) => {
  const { store, readers } = options;
  const fromStore = (error: { readonly message: string }) => failure(error.message);

  const sessionKey = (source: string, nativeId: string) => `${source}|${nativeId}`;

  /** Every session of every source, without the Claude and Codex sessions T3 threads ran. */
  const allSessions = Effect.gen(function* () {
    const [claude, codex, t3, t3Ids] = yield* Effect.all(
      [
        readers.claude.pipe(Effect.orElseSucceed(() => [])),
        readers.codex.pipe(Effect.orElseSucceed(() => [])),
        readers.t3,
        readers.t3NativeIds,
      ],
      { concurrency: "unbounded" },
    );
    const external = [...claude, ...codex].filter((session) => !t3Ids.has(session.nativeId));
    return [...t3, ...external];
  });

  const projectRootsOf = (initiativeId: string) =>
    store.list("project", { initiativeId }).pipe(
      Effect.mapError(fromStore),
      Effect.map((projects) => projects.map((project) => project.workspaceRoot)),
    );

  const catalog = (initiativeId: string) =>
    Effect.gen(function* () {
      const [sessions, projectRoots, records, available] = yield* Effect.all([
        allSessions,
        projectRootsOf(initiativeId),
        store.list("session").pipe(Effect.mapError(fromStore)),
        readers.available,
      ]);
      const imported = new Set<string>();
      const elsewhere = new Set<string>();
      for (const record of records) {
        if (record.assignment === "released") continue;
        (record.initiativeId === initiativeId ? imported : elsewhere).add(
          sessionKey(record.source, record.nativeId),
        );
      }
      return {
        sources: (Object.keys(SOURCE_NOTES) as Array<InitiativeImportSource>).map((source) => ({
          source,
          available: available[source],
          note: SOURCE_NOTES[source],
        })),
        groups: groupSessions({ sessions, projectRoots, imported, elsewhere }),
      } satisfies InitiativeImportCatalog;
    });

  /** The sessions a selection names, in a fixed order so a cursor points at the same one again. */
  const selected = (selection: ReadonlyArray<InitiativeImportSelection>) =>
    Effect.map(allSessions, (sessions) =>
      sessions
        .filter((session) =>
          selection.some(
            (choice) => choice.source === session.source && choice.cwd === (session.cwd ?? ""),
          ),
        )
        .toSorted((a, b) =>
          `${a.source}|${a.cwd}|${a.nativeId}`.localeCompare(`${b.source}|${b.cwd}|${b.nativeId}`),
        ),
    );

  /** Adds a session unless one with its native id exists anywhere. */
  const addSession = (
    initiativeId: string,
    session: ImportedSessionMeta & { readonly threadId?: ThreadId },
    assignment: InitiativeSession["assignment"],
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const existing = yield* store
        .findByKey("session", sessionKey(session.source, session.nativeId))
        .pipe(Effect.mapError(fromStore));
      if (Option.isSome(existing)) {
        // Taken out of this initiative before: the user brings it back on purpose.
        if (
          existing.value.initiativeId === initiativeId &&
          existing.value.assignment === "released"
        ) {
          yield* store
            .update("session", existing.value.id, { assignment }, { author })
            .pipe(Effect.mapError(fromStore));
          return true;
        }
        return false;
      }
      return yield* store
        .insert(
          "session",
          {
            initiativeId,
            source: session.source,
            nativeId: session.nativeId,
            environmentId: options.environmentId,
            threadId: session.threadId ?? null,
            title: session.title,
            cwd: session.cwd,
            branch: session.branch,
            assignment,
            launchJobId: null,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            prUrls: session.prUrls,
            model: session.model,
            tokens: session.tokens,
            summary: null,
          },
          author,
        )
        .pipe(
          Effect.as(true),
          Effect.catchTag("InitiativeStoreError", (error) =>
            error.reason === "duplicate" ? Effect.succeed(false) : Effect.fail(error),
          ),
          Effect.mapError(fromStore),
        );
    });

  const saveProgress = (job: InitiativeImportJob, patch: Partial<InitiativeImportJob>) =>
    Effect.gen(function* () {
      const current = yield* store.get("importJob", job.id).pipe(Effect.mapError(fromStore));
      const status = Option.isSome(current) ? current.value.status : job.status;
      const updated = yield* store
        .update("importJob", job.id, patch, { author: "system:import" })
        .pipe(Effect.mapError(fromStore));
      yield* options.changed(job.initiativeId);
      // A pause or cancel from the page wins over the job's own progress.
      return status === "running" ? updated : { ...updated, status };
    });

  const runMetadata = (job: InitiativeImportJob) =>
    Effect.gen(function* () {
      const items = yield* selected(job.selection);
      let { cursor, done, added, skipped } = job;
      for (let index = cursor; index < items.length; index += 1) {
        const item = items[index]!;
        const wasAdded = yield* addSession(
          job.initiativeId,
          item,
          "confirmed",
          `import:${item.source}`,
        );
        added += wasAdded ? 1 : 0;
        skipped += wasAdded ? 0 : 1;
        done += 1;
        cursor = index + 1;
        if (cursor % PROGRESS_EVERY === 0) {
          const saved = yield* saveProgress(job, {
            cursor,
            done,
            added,
            skipped,
            total: items.length,
          });
          if (saved.status !== "running") return;
        }
      }
      yield* saveProgress(job, {
        cursor,
        done,
        added,
        skipped,
        total: items.length,
        status: "done",
      });
    });

  const runSummaries = (job: InitiativeImportJob) =>
    Effect.gen(function* () {
      let { cursor, done, added, skipped, spentUsd } = job;
      for (let index = cursor; index < job.sessionIds.length; index += 1) {
        if (job.costCapUsd !== null && spentUsd >= job.costCapUsd) {
          yield* saveProgress(job, {
            cursor,
            done,
            added,
            skipped,
            spentUsd,
            status: "paused",
            error: "The cost cap is reached; raise it to go on.",
          });
          return;
        }
        const session = Option.getOrNull(
          yield* store.get("session", job.sessionIds[index]!).pipe(Effect.mapError(fromStore)),
        );
        let summarized = false;
        if (session && session.summary === null && session.source !== "t3") {
          const excerpt = yield* readers
            .excerpt(session.source, session.nativeId)
            .pipe(Effect.orElseSucceed(() => null));
          if (excerpt) {
            const result = yield* options.summarize(summaryPrompt(session.title, excerpt));
            spentUsd += result.costUsd;
            yield* store
              .update(
                "session",
                session.id,
                { summary: result.text.trim() },
                { author: "system:import" },
              )
              .pipe(Effect.mapError(fromStore));
            summarized = true;
          }
        }
        added += summarized ? 1 : 0;
        skipped += summarized ? 0 : 1;
        done += 1;
        cursor = index + 1;
        const saved = yield* saveProgress(job, { cursor, done, added, skipped, spentUsd });
        if (saved.status !== "running") return;
      }
      yield* saveProgress(job, { cursor, done, added, skipped, spentUsd, status: "done" });
    });

  /** Runs a job to its end, a pause or a failure, which it records. */
  const process = (job: InitiativeImportJob) =>
    (job.phase === "metadata" ? runMetadata(job) : runSummaries(job)).pipe(
      Effect.catch((error) =>
        store
          .update(
            "importJob",
            job.id,
            { status: "failed", error: error.message },
            { author: "system:import" },
          )
          .pipe(Effect.andThen(options.changed(job.initiativeId)), Effect.ignore),
      ),
    );

  const startJob = (
    input: Omit<
      InitiativeImportJob,
      "id" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
    >,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const job = yield* store.insert("importJob", input, author).pipe(Effect.mapError(fromStore));
      yield* options.changed(job.initiativeId);
      yield* options.fork(process(job));
      return job;
    });

  const run = (
    initiativeId: string,
    selection: ReadonlyArray<InitiativeImportSelection>,
    autoAssign: boolean,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      if (selection.length === 0) return yield* failure("Choose at least one folder to import.");
      if (autoAssign) {
        for (const choice of selection) {
          if (!choice.cwd) continue;
          const key = `${initiativeId}|${choice.source}|${choice.cwd}`;
          const rule = yield* store
            .findByKey("autoAssignRule", key)
            .pipe(Effect.mapError(fromStore));
          yield* (
            Option.isSome(rule)
              ? store.update("autoAssignRule", rule.value.id, { enabled: true }, { author })
              : store.insert(
                  "autoAssignRule",
                  { initiativeId, source: choice.source, cwdPrefix: choice.cwd, enabled: true },
                  author,
                )
          ).pipe(Effect.mapError(fromStore));
        }
      }
      return yield* startJob(
        {
          initiativeId,
          phase: "metadata",
          selection,
          sessionIds: [],
          status: "running",
          total: 0,
          done: 0,
          added: 0,
          skipped: 0,
          cursor: 0,
          costCapUsd: null,
          spentUsd: 0,
          error: null,
        },
        author,
      );
    });

  const summarizeSessions = (
    initiativeId: string,
    sessionIds: ReadonlyArray<string>,
    costCapUsd: number,
    author: InitiativeAuthor,
  ) =>
    startJob(
      {
        initiativeId,
        phase: "summary",
        selection: [],
        sessionIds,
        status: "running",
        total: sessionIds.length,
        done: 0,
        added: 0,
        skipped: 0,
        cursor: 0,
        costCapUsd,
        spentUsd: 0,
        error: null,
      },
      author,
    );

  const control = (
    jobId: string,
    action: "pause" | "resume" | "cancel",
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const job = Option.getOrNull(
        yield* store.get("importJob", jobId).pipe(Effect.mapError(fromStore)),
      );
      if (!job) return yield* failure(`No import ${jobId}.`);
      if (job.status === "done" || job.status === "cancelled") {
        return yield* failure(`This import is ${job.status}.`);
      }
      if (action === "resume" && job.status === "running") return job;
      const status = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "running";
      const updated = yield* store
        .update("importJob", job.id, { status, error: null }, { author })
        .pipe(Effect.mapError(fromStore));
      yield* options.changed(job.initiativeId);
      if (action === "resume") yield* options.fork(process(updated));
      return updated;
    });

  /**
   * Takes imported sessions out of the initiative again: deleted when they
   * came from a file, released when they are T3 threads.
   */
  const remove = (
    initiativeId: string,
    source: InitiativeImportSource,
    cwd: string | undefined,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const sessions = yield* store
        .list("session", { initiativeId })
        .pipe(Effect.mapError(fromStore));
      let removed = 0;
      for (const session of sessions) {
        if (session.source !== source) continue;
        if (cwd !== undefined && !isUnder(session.cwd, [cwd])) continue;
        if (source === "t3") {
          if (session.assignment === "released" || session.launchJobId !== null) continue;
          yield* store
            .update("session", session.id, { assignment: "released" }, { author })
            .pipe(Effect.mapError(fromStore));
        } else {
          yield* store.remove("session", session.id, author).pipe(Effect.mapError(fromStore));
        }
        removed += 1;
      }
      yield* options.changed(initiativeId);
      return removed;
    });

  /** New sessions in the folders of enabled rules join their initiative on their own. */
  const applyAutoAssign = Effect.gen(function* () {
    const rules = (yield* store.list("autoAssignRule").pipe(Effect.mapError(fromStore))).filter(
      (rule) => rule.enabled,
    );
    if (rules.length === 0) return 0;
    const sessions = yield* allSessions;
    let added = 0;
    for (const rule of rules) {
      for (const session of sessions) {
        if (session.source !== rule.source || !isUnder(session.cwd, [rule.cwdPrefix])) continue;
        if (yield* addSession(rule.initiativeId, session, "auto", `import:${session.source}`)) {
          added += 1;
        }
      }
      if (added > 0) yield* options.changed(rule.initiativeId);
    }
    return added;
  });

  /** After a restart: a job that was running continues. */
  const resumeAfterRestart = Effect.gen(function* () {
    const jobs = yield* store.list("importJob").pipe(Effect.mapError(fromStore));
    for (const job of jobs) {
      if (job.status === "running") yield* options.fork(process(job));
    }
  });

  return {
    catalog,
    run,
    summarizeSessions,
    control,
    remove,
    applyAutoAssign,
    resumeAfterRestart,
    process,
  };
};

export type InitiativeImport = ReturnType<typeof makeInitiativeImport>;
