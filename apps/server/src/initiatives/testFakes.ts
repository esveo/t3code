/**
 * Fork: in-memory stand-ins for the initiatives' tests: a ThreadBridge over a
 * thread map and a brain without git. The real BrainArchive has its own test.
 */
import {
  type InitiativeLaunchJob,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import { type ThreadBridge, ThreadBridgeError } from "@t3tools/initiatives/bridge";
import { ensureInitiativeSchema, makeInitiativeStore } from "@t3tools/initiatives/store";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type BrainArchiveShape, BrainError } from "./BrainArchive.ts";
import type { ImportedSessionMeta } from "@t3tools/initiatives/importers";

import type { ImportReaders, Summarize } from "./InitiativeImport.ts";
import { makeInitiatives } from "./Initiatives.ts";

export const TEST_PROJECT = ProjectId.make("project-1");

export const testShell = (threadId: string, overrides: Partial<OrchestrationThreadShell> = {}) =>
  ({
    id: ThreadId.make(threadId),
    projectId: TEST_PROJECT,
    title: threadId,
    branch: "feature",
    worktreePath: "/worktrees/feature",
    pullRequests: [],

    pinnedAt: null,
    ...overrides,
  }) as OrchestrationThreadShell;

/**
 * A bridge over an in-memory thread list. `failNextStart` makes the next
 * start fail; `crashAfterCreate` creates the thread and then dies, as a
 * server stopping between creating the thread and recording it would.
 */
export const makeFakeBridge = () => {
  const threads = new Map<string, OrchestrationThreadShell>();
  const starts: Array<{ job: InitiativeLaunchJob; prompt: string }> = [];
  const projects = [{ projectId: TEST_PROJECT, title: "Web", workspaceRoot: "/repo/web" }];
  const state = { failNextStart: false, crashAfterCreate: false };
  const activity = new Map<
    string,
    { turns: number; firstAt: string | null; lastAt: string | null }
  >();
  const interrupts: Array<string> = [];
  const messages: Array<{ threadId: string; text: string }> = [];
  const usage: Array<{
    instanceId: string;
    driver: string;
    usageLimits: ServerProviderUsageLimits | null;
  }> = [];
  const update = (threadId: string, patch: Partial<OrchestrationThreadShell>) => {
    const thread = threads.get(threadId);
    if (thread) threads.set(threadId, { ...thread, ...patch });
  };
  const bridge: ThreadBridge = {
    capabilities: { runtimeModes: ["auto"], lineage: "one-level" },
    resolveModel: (input) =>
      Effect.succeed({
        modelSelection: {
          instanceId: ProviderInstanceId.make(input.provider ?? "codex"),
          model: input.model ?? "gpt-6",
        },
        driver: input.provider === "opencode" ? "opencode" : (input.provider ?? "codex"),
      }),
    startThread: (job, prompt) =>
      Effect.suspend(() => {
        if (state.failNextStart) {
          state.failNextStart = false;
          return Effect.fail(new ThreadBridgeError({ message: "Could not create the worktree" }));
        }
        if (threads.has(job.threadId)) {
          return Effect.fail(new ThreadBridgeError({ message: "Thread exists" }));
        }
        starts.push({ job, prompt });
        threads.set(
          job.threadId,
          testShell(job.threadId, {
            title: job.spec.title,
            projectId: job.spec.projectId,
            modelSelection: {
              instanceId: ProviderInstanceId.make(job.spec.provider ?? "codex"),
              model: job.spec.model ?? "gpt-6",
            },
            ...(job.spec.parentThreadId ? { parentThreadId: job.spec.parentThreadId } : {}),
          }),
        );
        if (state.crashAfterCreate) return Effect.die("server stopped");
        return Effect.succeed({ threadId: job.threadId, branch: "feature", worktree: true });
      }),
    findThread: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
    listThreads: () => Effect.succeed([...threads.values()]),
    listProjects: () => Effect.succeed(projects),
    ensureProject: (input) =>
      Effect.sync(() => {
        const existing = projects.find((project) => project.workspaceRoot === input.workspaceRoot);
        if (existing) return existing;
        const created = {
          projectId: ProjectId.make(`project-${projects.length + 1}`),
          title: input.title,
          workspaceRoot: input.workspaceRoot,
        };
        projects.push(created);
        return created;
      }),
    setPinned: (threadId, pinned) =>
      Effect.sync(() => update(threadId, { pinnedAt: pinned ? "2026-09-26T10:00:00.000Z" : null })),
    setParent: (threadId, parentThreadId) =>
      Effect.sync(() => update(threadId, { parentThreadId: parentThreadId ?? undefined })),
    interruptThread: (threadId) =>
      Effect.sync(() => {
        const thread = threads.get(threadId);
        if (thread?.session?.status !== "running") return false;
        interrupts.push(threadId);
        threads.set(threadId, { ...thread, session: { ...thread.session, status: "ready" } });
        return true;
      }),
    sendMessage: (threadId, text) =>
      threads.has(threadId)
        ? Effect.sync(() => void messages.push({ threadId, text }))
        : Effect.fail(new ThreadBridgeError({ message: `Thread ${threadId} was not found.` })),
    threadActivity: (threadId) => Effect.sync(() => activity.get(threadId) ?? null),
    providerUsage: () => Effect.sync(() => usage),
  };
  return { bridge, threads, starts, state, projects, activity, usage, interrupts, messages };
};

/** A brain that keeps its pages in a map and counts commits instead of running git. */
export const makeMemoryArchive = () => {
  const repos = new Map<string, Map<string, { markdown: string; commit: string }>>();
  let commits = 0;
  const state = { failWrites: false };
  const archive: BrainArchiveShape = {
    ensure: (initiativeId, pages) =>
      Effect.sync(() => {
        if (repos.has(initiativeId)) return { created: false };
        const commit = `c${++commits}`;
        repos.set(
          initiativeId,
          new Map(pages.map((page) => [page.path, { markdown: page.markdown, commit }])),
        );
        return { created: true };
      }),
    exists: (initiativeId) => Effect.succeed(repos.has(initiativeId)),
    read: (initiativeId, path) =>
      Effect.succeed(repos.get(initiativeId)?.get(path)?.markdown ?? null),
    write: (initiativeId, input) =>
      Effect.suspend((): Effect.Effect<{ commit: string; changed: boolean }, BrainError> => {
        if (state.failWrites) {
          return Effect.fail(new BrainError({ message: "git commit failed: disk full" }));
        }
        const repo = repos.get(initiativeId)!;
        const current = repo.get(input.path);
        if (current?.markdown === input.markdown) {
          return Effect.succeed({ commit: current.commit, changed: false });
        }
        const commit = `c${++commits}`;
        repo.set(input.path, { markdown: input.markdown, commit });
        return Effect.succeed({ commit, changed: true });
      }),
    search: (initiativeId, query) =>
      Effect.succeed(
        [...(repos.get(initiativeId) ?? new Map()).entries()].flatMap(([path, page]) =>
          page.markdown
            .split("\n")
            .flatMap((text: string, index: number) =>
              text.toLowerCase().includes(query.toLowerCase())
                ? [{ path, line: index + 1, text }]
                : [],
            ),
        ),
      ),
    history: (initiativeId, path) =>
      Effect.succeed(
        repos.get(initiativeId)?.get(path)
          ? [
              {
                commit: repos.get(initiativeId)!.get(path)!.commit,
                author: "",
                at: "",
                message: "",
              },
            ]
          : [],
      ),
    pages: (initiativeId) =>
      Effect.succeed(
        [...(repos.get(initiativeId) ?? new Map()).entries()].map(([path, page]) => ({
          path,
          commit: page.commit,
        })),
      ),
    recover: () => Effect.succeed(null),
  };
  return { archive, repos, state };
};

/**
 * Import sources in memory: sessions per source, excerpts per native id and
 * a summarizer that costs a fixed amount per call.
 */
export const makeFakeReaders = () => {
  const sessions: Record<"claude" | "codex", Array<ImportedSessionMeta>> = {
    claude: [],
    codex: [],
  };
  const t3NativeIds = new Set<string>();
  const excerpts = new Map<string, string>();
  const state = { summaries: 0, costPerSummary: 0.01 };
  const readers: ImportReaders = {
    claude: Effect.sync(() => sessions.claude),
    codex: Effect.sync(() => sessions.codex),
    t3: Effect.succeed([]),
    t3NativeIds: Effect.sync(() => t3NativeIds),
    excerpt: (_source, nativeId) => Effect.sync(() => excerpts.get(nativeId) ?? null),
    available: Effect.succeed({
      t3: true,
      "claude-code-cli": true,
      "claude-desktop": true,
      codex: true,
    }),
  };
  const summarize: Summarize = (prompt) =>
    Effect.sync(() => {
      state.summaries += 1;
      return {
        text: `Zusammenfassung ${state.summaries} (${prompt.length})`,
        costUsd: state.costPerSummary,
      };
    });
  return { readers, summarize, sessions, t3NativeIds, excerpts, state };
};

/** A service on a fresh in-memory store, with the fakes above. */
export const makeTestInitiatives = Effect.gen(function* () {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* ensureInitiativeSchema(sql);
  let counter = 0;
  const newId = Effect.sync(() => `id-${++counter}`);
  const store = makeInitiativeStore({ sql, newId });
  const fake = makeFakeBridge();
  const memory = makeMemoryArchive();
  const readers = makeFakeReaders();
  /** A server process on the same database; run it again for a restart. */
  const boot = makeInitiatives({
    store,
    bridge: fake.bridge,
    newId,
    environmentId: null,
    archive: memory.archive,
    workspaceRootOf: (initiativeId) => `/state/initiatives/${initiativeId}/workspace`,
    digest: (text) => Effect.succeed(`hash:${text.length}`),
    importReaders: readers.readers,
    summarize: readers.summarize,
    readUsage: () =>
      Effect.succeed({
        costUsd: 1.5,
        totalTokens: 1000,
        input: 600,
        output: 300,
        cacheRead: 100,
        cacheWrite: 0,
      }),
  });
  const initiatives = yield* boot;
  return { initiatives, boot, store, fake, memory, newId, readers };
});
