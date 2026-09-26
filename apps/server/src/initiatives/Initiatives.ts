/**
 * Fork: initiatives ("Vorhaben"). The module keeps its records in its own
 * store and reaches threads only through the ThreadBridge. The Initiatives
 * page reads it through two subscriptions and changes it through `act`; the
 * MCP tools of an initiative's threads call the same service.
 *
 * Starting a thread writes a launch job first, with the thread's id chosen up
 * front, then starts the thread, then marks the job started and assigns the
 * session in one transaction. After a restart, a job still marked created is
 * checked against the threads: found, it is finished; missing, it failed. A
 * job is never started twice.
 */
import {
  type EnvironmentId,
  type Initiative,
  type InitiativeAuthor,
  type InitiativeDetailSnapshot,
  type InitiativeLaunchJob,
  InitiativesError,
  type InitiativesAction,
  type InitiativesActResult,
  type InitiativesListSnapshot,
  type InitiativeSession,
  type InitiativeUsageResult,
  type OrchestrationThreadShell,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { clampForPrompt } from "@t3tools/initiatives/brain";
import type { ThreadBridge } from "@t3tools/initiatives/bridge";
import {
  initiativeRuntimeMode,
  initiativeStartPrompt,
  type InitiativeRole,
  systemAuthor,
} from "@t3tools/initiatives/model";
import {
  ensureInitiativeSchema,
  type InitiativeRecordPatch,
  type InitiativeStore,
  type InitiativeStoreError,
  makeInitiativeStore,
} from "@t3tools/initiatives/store";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageService from "../usage/UsageService.ts";
import { readThreadUsage } from "../usage/ThreadUsageQuery.ts";
import { type BrainArchiveShape, makeBrainArchive } from "./BrainArchive.ts";
import { type InitiativeBrain, makeInitiativeBrain } from "./InitiativeBrain.ts";
import { InitiativesSql } from "./InitiativesSql.ts";
import { makeThreadBridgeV1 } from "./ThreadBridgeV1.ts";

export interface LaunchInput {
  readonly initiativeId: string;
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly worktree?: boolean | undefined;
  readonly baseBranch?: string | undefined;
  /** Defaults to the initiative's coordinator; a coordinator itself has none. */
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly role?: InitiativeRole | undefined;
}

/** A thread's place in an initiative, as its MCP tools see it. */
export interface ThreadMembership {
  readonly initiative: Initiative;
  readonly session: InitiativeSession;
}

export interface InitiativesShape {
  readonly store: InitiativeStore;
  readonly act: (
    action: InitiativesAction,
    author: InitiativeAuthor,
  ) => Effect.Effect<InitiativesActResult, InitiativesError>;
  readonly launch: (
    input: LaunchInput,
    author: InitiativeAuthor,
  ) => Effect.Effect<InitiativeLaunchJob, InitiativesError>;
  /** Finishes or fails the launch jobs a restart interrupted. */
  readonly reconcile: (before: string) => Effect.Effect<void, InitiativesError>;
  readonly membershipOf: (
    threadId: string,
  ) => Effect.Effect<Option.Option<ThreadMembership>, InitiativesError>;
  readonly listSnapshot: Effect.Effect<InitiativesListSnapshot, InitiativesError>;
  readonly detailSnapshot: (
    initiativeId: string,
  ) => Effect.Effect<InitiativeDetailSnapshot, InitiativesError>;
  readonly subscribeList: Stream.Stream<InitiativesListSnapshot, InitiativesError>;
  readonly subscribeDetail: (
    initiativeId: string,
  ) => Stream.Stream<InitiativeDetailSnapshot, InitiativesError>;
  readonly usage: (initiativeId: string) => Effect.Effect<InitiativeUsageResult, InitiativesError>;
  readonly threads: ThreadBridge;
  readonly brain: InitiativeBrain;
  /** After a restart: commits what a crash left in the brains and syncs their records. */
  readonly recoverBrains: Effect.Effect<void>;
}

export class Initiatives extends Context.Service<Initiatives, InitiativesShape>()(
  "t3/initiatives/Initiatives",
) {}

const failure = (message: string) => new InitiativesError({ message });
const fromStore = (error: InitiativeStoreError) => failure(error.message);
const fromBridge = (error: { readonly message: string }) => failure(error.message);

/** How long a thread's usage stays cached; reading it scans the provider's transcripts. */
const USAGE_TTL_MS = 5 * 60 * 1000;

/** The steckbrief rides in every start prompt, so it stays short there. */
const STECKBRIEF_PROMPT_LIMIT = 4000;

export const makeInitiatives = (options: {
  readonly store: InitiativeStore;
  readonly bridge: ThreadBridge;
  readonly newId: Effect.Effect<string>;
  readonly environmentId: EnvironmentId | null;
  readonly archive: BrainArchiveShape;
  /** Where initiatives without a code project work: `<root>/<initiative id>/workspace`. */
  readonly workspaceRootOf: (initiativeId: string) => string;
  /** API-equivalent cost and tokens of one thread, or null when unknown. */
  readonly readUsage: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly costUsd: number; readonly totalTokens: number } | null>;
}) =>
  Effect.gen(function* () {
    const { store, bridge, newId, environmentId } = options;
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<string | null>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const changed = (initiativeId: string | null) => PubSub.publish(changes, initiativeId);
    const brain = makeInitiativeBrain({ store, archive: options.archive, changed });
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const usageCache = new Map<
      string,
      { readonly at: number; readonly value: { costUsd: number; totalTokens: number } | null }
    >();

    const requireInitiative = (initiativeId: string) =>
      store.get("initiative", initiativeId).pipe(
        Effect.mapError(fromStore),
        Effect.flatMap((found) =>
          Option.isSome(found)
            ? Effect.succeed(found.value)
            : Effect.fail(failure(`No initiative ${initiativeId}.`)),
        ),
      );

    const sessionKey = (threadId: string) => `t3|${threadId}`;

    /** Assigns a thread, or moves it here from another initiative. */
    const assignThread = (input: {
      readonly initiativeId: string;
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId | null;
      readonly assignment: InitiativeSession["assignment"];
      readonly launchJobId: string | null;
      readonly shell: OrchestrationThreadShell | null;
      readonly title?: string | undefined;
      readonly author: InitiativeAuthor;
    }) =>
      Effect.gen(function* () {
        const existing = yield* store.findByKey("session", sessionKey(input.threadId));
        const fields = {
          initiativeId: input.initiativeId,
          assignment: input.assignment,
          ...(input.shell
            ? {
                title: input.shell.title,
                branch: input.shell.branch,
                cwd: input.shell.worktreePath,
              }
            : input.title
              ? { title: input.title }
              : {}),
          ...(input.launchJobId ? { launchJobId: input.launchJobId } : {}),
        };
        if (Option.isSome(existing)) {
          return yield* store.update("session", existing.value.id, fields, {
            author: input.author,
          });
        }
        return yield* store.insert(
          "session",
          {
            source: "t3",
            nativeId: input.threadId,
            environmentId: input.environmentId,
            threadId: input.threadId,
            title: input.shell?.title ?? input.title ?? "Thread",
            cwd: input.shell?.worktreePath ?? null,
            branch: input.shell?.branch ?? null,
            launchJobId: input.launchJobId,
            ...fields,
          },
          input.author,
        );
      });

    /** Marks a job started and assigns its thread, both or neither. */
    const finishLaunch = (
      job: InitiativeLaunchJob,
      shell: OrchestrationThreadShell | null,
      author: InitiativeAuthor,
    ) =>
      store
        .transaction(
          Effect.gen(function* () {
            yield* store.update(
              "launchJob",
              job.id,
              { status: "started", error: null },
              { author },
            );
            yield* assignThread({
              initiativeId: job.initiativeId,
              threadId: job.threadId,
              environmentId,
              assignment: "auto",
              launchJobId: job.id,
              shell,
              title: job.spec.title,
              author,
            });
          }),
        )
        .pipe(
          Effect.mapError(fromStore),
          Effect.andThen(
            job.spec.role === "coordinator" ? promoteCoordinator(job, author) : Effect.void,
          ),
        );

    /**
     * Makes a started coordinator the initiative's one: pinned, recorded, and
     * the threads of the one before it report to it. Safe to repeat.
     */
    const promoteCoordinator = (job: InitiativeLaunchJob, author: InitiativeAuthor) =>
      Effect.gen(function* () {
        const initiative = yield* requireInitiative(job.initiativeId);
        const previous = initiative.coordinatorThreadId;
        if (previous !== job.threadId) {
          yield* store
            .update("initiative", initiative.id, { coordinatorThreadId: job.threadId }, { author })
            .pipe(Effect.mapError(fromStore));
        }
        // Thread changes are best effort: the record above is what counts.
        const ignore = Effect.ignoreCause({ log: true });
        yield* bridge.setPinned(job.threadId, true).pipe(ignore);
        if (previous && previous !== job.threadId) {
          yield* bridge.setPinned(previous, false).pipe(ignore);
          const threads = yield* bridge.listThreads().pipe(Effect.orElseSucceed(() => []));
          for (const thread of threads) {
            if (thread.parentThreadId === previous) {
              yield* bridge.setParent(thread.id, job.threadId).pipe(ignore);
            }
          }
        }
      });

    const failLaunch = (job: InitiativeLaunchJob, error: string, author: InitiativeAuthor) =>
      store
        .update("launchJob", job.id, { status: "failed", error }, { author })
        .pipe(Effect.mapError(fromStore));

    const launch: InitiativesShape["launch"] = (input, author) =>
      Effect.gen(function* () {
        const existing = yield* store
          .findByKey("launchJob", input.key)
          .pipe(Effect.mapError(fromStore));
        if (Option.isSome(existing)) return existing.value;
        const initiative = yield* requireInitiative(input.initiativeId);
        if (initiative.status !== "active") {
          return yield* failure(`${initiative.title} is ${initiative.status}; reopen it first.`);
        }
        if (initiative.halted) {
          return yield* failure(`${initiative.title} is halted: no new threads start.`);
        }
        const role: InitiativeRole = input.role ?? "participant";
        const parentThreadId =
          role === "coordinator"
            ? null
            : input.parentThreadId !== undefined
              ? input.parentThreadId
              : initiative.coordinatorThreadId;
        const resolved = yield* bridge
          .resolveModel({
            projectId: input.projectId,
            parentThreadId,
            provider: input.provider ?? null,
            model: input.model ?? null,
          })
          .pipe(Effect.mapError(fromBridge));
        const instanceId = resolved.modelSelection.instanceId;
        if (initiative.providerExclusions.includes(instanceId)) {
          return yield* failure(
            `${instanceId} is excluded from ${initiative.title}. Pick another provider.`,
          );
        }
        const { job, fresh } = yield* store
          .insert(
            "launchJob",
            {
              initiativeId: initiative.id,
              key: input.key,
              threadId: ThreadId.make(yield* newId),
              spec: {
                role,
                projectId: input.projectId,
                title: input.title,
                prompt: input.prompt,
                provider: instanceId,
                model: resolved.modelSelection.model,
                runtimeMode: initiativeRuntimeMode(resolved.driver),
                worktree: input.worktree !== false,
                baseBranch: input.baseBranch ?? null,
                parentThreadId,
              },
              status: "created",
              error: null,
            },
            author,
          )
          .pipe(
            Effect.map((inserted) => ({ job: inserted, fresh: true })),
            // Two starts with one key at once: the second returns the first's job.
            Effect.catchTag("InitiativeStoreError", (error) =>
              error.reason === "duplicate"
                ? store
                    .findByKey("launchJob", input.key)
                    .pipe(
                      Effect.flatMap((found) =>
                        Option.isSome(found)
                          ? Effect.succeed({ job: found.value, fresh: false })
                          : Effect.fail(error),
                      ),
                    )
                : Effect.fail(error),
            ),
            Effect.mapError(fromStore),
          );
        if (!fresh) return job;
        yield* changed(initiative.id);
        // The steckbrief and handoff are read at every start, so a start never uses a stale one.
        const startBrain = yield* brain.startBrain(initiative);
        const started = yield* bridge
          .startThread(
            job,
            initiativeStartPrompt({
              initiative,
              role,
              prompt: input.prompt,
              brain: {
                steckbrief: startBrain.steckbrief
                  ? clampForPrompt(startBrain.steckbrief, STECKBRIEF_PROMPT_LIMIT)
                  : null,
                handoff: role === "coordinator" ? startBrain.handoff : null,
              },
            }),
          )
          .pipe(Effect.result);
        if (started._tag === "Failure") {
          yield* failLaunch(job, started.failure.message, author);
          yield* changed(initiative.id);
          return yield* failure(started.failure.message);
        }
        const shell = yield* bridge.findThread(job.threadId).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        );
        yield* finishLaunch(job, shell, author);
        yield* changed(initiative.id);
        return { ...job, status: "started" as const };
      });

    const reconcile: InitiativesShape["reconcile"] = (before) =>
      Effect.gen(function* () {
        const author = systemAuthor("reconcile");
        const open = (yield* store.list("launchJob").pipe(Effect.mapError(fromStore))).filter(
          (job) => job.status === "created" && job.createdAt < before,
        );
        for (const job of open) {
          const thread = yield* bridge.findThread(job.threadId).pipe(Effect.mapError(fromBridge));
          if (Option.isSome(thread)) {
            yield* finishLaunch(job, thread.value, author);
          } else {
            yield* failLaunch(
              job,
              "The server stopped before the thread was created; it was not started again.",
              author,
            );
          }
          yield* changed(job.initiativeId);
        }
      });

    const membershipOf: InitiativesShape["membershipOf"] = (threadId) =>
      Effect.gen(function* () {
        const session = yield* store
          .findByKey("session", sessionKey(threadId))
          .pipe(Effect.mapError(fromStore));
        if (Option.isNone(session) || session.value.assignment === "released") return Option.none();
        const initiative = yield* store
          .get("initiative", session.value.initiativeId)
          .pipe(Effect.mapError(fromStore));
        return Option.map(initiative, (found) => ({ initiative: found, session: session.value }));
      });

    const listSnapshot: InitiativesShape["listSnapshot"] = Effect.gen(function* () {
      const [initiatives, projects, sessions] = yield* Effect.all([
        store.list("initiative"),
        store.list("project"),
        store.list("session"),
      ]).pipe(Effect.mapError(fromStore));
      return {
        initiatives: initiatives.map((initiative) => {
          const own = sessions.filter(
            (session) =>
              session.initiativeId === initiative.id && session.assignment !== "released",
          );
          return {
            initiative,
            projects: projects.filter((project) => project.initiativeId === initiative.id),
            threads: own.flatMap((session) =>
              session.threadId
                ? [{ environmentId: session.environmentId, threadId: session.threadId }]
                : [],
            ),
            sessionCount: own.length,
          };
        }),
      };
    });

    const detailSnapshot: InitiativesShape["detailSnapshot"] = (initiativeId) =>
      Effect.gen(function* () {
        const [initiative, projects, sessions, launchJobs, brainPages] = yield* Effect.all([
          store.get("initiative", initiativeId),
          store.list("project", { initiativeId }),
          store.list("session", { initiativeId }),
          store.list("launchJob", { initiativeId }),
          store.list("brainPage", { initiativeId }),
        ]).pipe(Effect.mapError(fromStore));
        return {
          initiative: Option.getOrNull(initiative),
          projects,
          sessions,
          launchJobs: launchJobs.filter((job) => job.status !== "dismissed"),
          brainPages,
          brainError: brain.errorOf(initiativeId),
        };
      });

    const subscribeTo = <A>(
      snapshot: Effect.Effect<A, InitiativesError>,
      relevant: (id: string | null) => boolean,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(relevant),
              Stream.mapEffect(() => snapshot),
            ),
          );
        }),
      );

    const act: InitiativesShape["act"] = (action, author) =>
      Effect.gen(function* () {
        switch (action.type) {
          case "create": {
            const created = yield* store
              .insert(
                "initiative",
                {
                  title: action.title,
                  goalText: action.goalText ?? "",
                  status: "active",
                  instructionsMd: action.instructionsMd ?? "",
                  homeEnvironmentId: environmentId,
                  providerExclusions: [],
                  coordinatorThreadId: null,
                  halted: false,
                },
                author,
              )
              .pipe(Effect.mapError(fromStore));
            // A failed brain shows on the page; the initiative exists either way.
            yield* brain.ensure(created, author).pipe(Effect.ignore);
            yield* changed(created.id);
            return { id: created.id };
          }
          case "update": {
            const { type: _type, initiativeId, expectedRevision, ...fields } = action;
            // Only the fields the action names change.
            const patch = Object.fromEntries(
              Object.entries(fields).filter(([, value]) => value !== undefined),
            ) as InitiativeRecordPatch<"initiative">;
            const updated = yield* store
              .update("initiative", initiativeId, patch, { author, expectedRevision })
              .pipe(Effect.mapError(fromStore));
            yield* changed(updated.id);
            return { id: updated.id };
          }
          case "archive":
          case "reopen": {
            const updated = yield* store
              .update(
                "initiative",
                action.initiativeId,
                { status: action.type === "archive" ? "archived" : "active" },
                { author },
              )
              .pipe(Effect.mapError(fromStore));
            yield* changed(updated.id);
            return { id: updated.id };
          }
          case "addProject": {
            yield* requireInitiative(action.initiativeId);
            const projects = yield* bridge.listProjects().pipe(Effect.mapError(fromBridge));
            const project = projects.find((candidate) => candidate.projectId === action.projectId);
            if (!project) return yield* failure(`Project ${action.projectId} was not found.`);
            const added = yield* store
              .insert(
                "project",
                {
                  initiativeId: action.initiativeId,
                  environmentId,
                  projectId: project.projectId,
                  workspaceRoot: project.workspaceRoot,
                  label: project.title,
                },
                author,
              )
              .pipe(
                Effect.mapError((error) =>
                  error.reason === "duplicate"
                    ? failure(`${project.title} belongs to this initiative already.`)
                    : fromStore(error),
                ),
              );
            yield* changed(action.initiativeId);
            return { id: added.id };
          }
          case "removeProject": {
            yield* store
              .remove("project", action.initiativeProjectId, author)
              .pipe(Effect.mapError(fromStore));
            yield* changed(action.initiativeId);
            return { id: action.initiativeProjectId };
          }
          case "assignThread": {
            yield* requireInitiative(action.initiativeId);
            const local =
              action.environmentId === undefined || action.environmentId === environmentId;
            const shell = local
              ? Option.getOrNull(
                  yield* bridge.findThread(action.threadId).pipe(Effect.mapError(fromBridge)),
                )
              : null;
            if (local && shell === null)
              return yield* failure(`Thread ${action.threadId} was not found.`);
            const previous = yield* store
              .findByKey("session", sessionKey(action.threadId))
              .pipe(Effect.mapError(fromStore));
            const session = yield* assignThread({
              initiativeId: action.initiativeId,
              threadId: action.threadId,
              environmentId: action.environmentId ?? environmentId,
              assignment: "confirmed",
              launchJobId: null,
              shell,
              title: action.title,
              author,
            }).pipe(Effect.mapError(fromStore));
            if (Option.isSome(previous) && previous.value.initiativeId !== action.initiativeId) {
              yield* changed(previous.value.initiativeId);
            }
            yield* changed(action.initiativeId);
            return { id: session.id };
          }
          case "unassignThread": {
            const session = yield* store
              .findByKey("session", sessionKey(action.threadId))
              .pipe(Effect.mapError(fromStore));
            if (Option.isNone(session) || session.value.initiativeId !== action.initiativeId) {
              return yield* failure("This thread is not assigned to the initiative.");
            }
            yield* store
              .update("session", session.value.id, { assignment: "released" }, { author })
              .pipe(Effect.mapError(fromStore));
            yield* changed(action.initiativeId);
            return { id: session.value.id };
          }
          case "startThread": {
            const job = yield* launch(
              {
                initiativeId: action.initiativeId,
                key: action.key,
                projectId: action.projectId,
                title: action.title,
                prompt: action.prompt,
                provider: action.provider,
                model: action.model,
                worktree: action.worktree,
              },
              author,
            );
            return { id: job.threadId };
          }
          case "dismissLaunch": {
            const job = yield* store
              .get("launchJob", action.launchJobId)
              .pipe(Effect.mapError(fromStore));
            if (Option.isNone(job) || job.value.status !== "failed") {
              return yield* failure("Only a failed start can be dismissed.");
            }
            yield* store
              .update("launchJob", job.value.id, { status: "dismissed" }, { author })
              .pipe(Effect.mapError(fromStore));
            yield* changed(action.initiativeId);
            return { id: job.value.id };
          }
          case "startCoordinator": {
            const initiative = yield* requireInitiative(action.initiativeId);
            const projects = yield* store
              .list("project", { initiativeId: initiative.id })
              .pipe(Effect.mapError(fromStore));
            // Work without code gets a folder of the initiative's own as its project.
            const projectId =
              action.projectId ??
              projects.find((project) => project.projectId !== null)?.projectId ??
              (yield* bridge
                .ensureProject({
                  workspaceRoot: options.workspaceRootOf(initiative.id),
                  title: `Vorhaben: ${initiative.title}`,
                })
                .pipe(Effect.mapError(fromBridge))).projectId;
            const job = yield* launch(
              {
                initiativeId: initiative.id,
                key: action.key,
                projectId,
                title: `Koordinator: ${initiative.title}`,
                prompt:
                  action.message?.trim() ||
                  "Continue the initiative from the handoff above: check the state of its threads with session_list, then take the next step. When there is nothing to continue, tell the user briefly where the initiative stands and ask what to do next.",
                provider: action.provider,
                model: action.model,
                // The coordinator orchestrates; its threads get the worktrees.
                worktree: false,
                role: "coordinator",
              },
              author,
            );
            return { id: job.threadId };
          }
          case "brainWrite": {
            const initiative = yield* requireInitiative(action.initiativeId);
            const written = yield* brain.write(initiative, {
              path: action.path,
              markdown: action.markdown,
              author,
            });
            return { id: written.path };
          }
          case "brainUnlock": {
            yield* brain.unlock(action.initiativeId, action.path, author);
            return { id: action.path };
          }
        }
      });

    const usage: InitiativesShape["usage"] = (initiativeId) =>
      Effect.gen(function* () {
        const sessions = yield* store
          .list("session", { initiativeId })
          .pipe(Effect.mapError(fromStore));
        const local = sessions.filter(
          (session) =>
            session.threadId !== null &&
            session.assignment !== "released" &&
            (session.environmentId === null || session.environmentId === environmentId),
        );
        const now = yield* Clock.currentTimeMillis;
        const threads = yield* Effect.forEach(
          local,
          (session) =>
            Effect.gen(function* () {
              const threadId = session.threadId!;
              const cached = usageCache.get(threadId);
              const value =
                cached && now - cached.at < USAGE_TTL_MS
                  ? cached.value
                  : yield* options.readUsage(threadId);
              usageCache.set(threadId, { at: now, value });
              return {
                threadId,
                costUsd: value?.costUsd ?? null,
                totalTokens: value?.totalTokens ?? null,
              };
            }),
          { concurrency: 4 },
        );
        return { threads, readAt: yield* nowIso };
      });

    return {
      store,
      act,
      launch,
      reconcile,
      membershipOf,
      listSnapshot,
      detailSnapshot,
      subscribeList: subscribeTo(listSnapshot, () => true),
      subscribeDetail: (initiativeId) =>
        subscribeTo(detailSnapshot(initiativeId), (id) => id === null || id === initiativeId),
      usage,
      threads: bridge,
      brain,
      recoverBrains: Effect.gen(function* () {
        const initiatives = yield* store.list("initiative").pipe(Effect.orElseSucceed(() => []));
        for (const initiative of initiatives) {
          if (yield* options.archive.exists(initiative.id)) {
            yield* brain.recover(initiative.id).pipe(Effect.ignore);
          }
        }
      }),
    } satisfies InitiativesShape;
  });

export const layer = Layer.effect(
  Initiatives,
  Effect.gen(function* () {
    const sql = yield* InitiativesSql;
    const mainSql = yield* SqlClient.SqlClient;
    const usageService = yield* UsageService.UsageService;
    const crypto = yield* Crypto.Crypto;
    const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment);
    const environmentId = Option.isSome(serverEnvironment)
      ? yield* serverEnvironment.value.getEnvironmentId
      : null;
    yield* ensureInitiativeSchema(sql).pipe(Effect.orDie);
    const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const store = makeInitiativeStore({ sql, newId });
    const bridge = yield* makeThreadBridgeV1;
    const { stateDir } = yield* ServerConfig;
    const path = yield* Path.Path;
    const initiativesDir = path.join(stateDir, "initiatives");
    const archive = yield* makeBrainArchive(initiativesDir).pipe(
      Effect.provide(ProcessRunner.layer),
    );
    const service = yield* makeInitiatives({
      store,
      bridge,
      newId,
      environmentId,
      archive,
      workspaceRootOf: (initiativeId) => path.join(initiativesDir, initiativeId, "workspace"),
      readUsage: (threadId) =>
        readThreadUsage({ threadId }).pipe(
          Effect.provideService(UsageService.UsageService, usageService),
          Effect.provideService(SqlClient.SqlClient, mainSql),
          Effect.map((summary) =>
            summary.matched
              ? {
                  costUsd: summary.costUsd,
                  totalTokens:
                    summary.totals.uncachedInputTokens +
                    summary.totals.cachedInputTokens +
                    summary.totals.cacheCreationTokens +
                    summary.totals.outputTokens,
                }
              : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
    });
    // Jobs a restart interrupted were written before this server started.
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    yield* forkParked(
      service
        .reconcile(startedAt)
        .pipe(Effect.ignoreCause({ log: true }), Effect.andThen(service.recoverBrains)),
    );
    return Initiatives.of(service);
  }),
);

/**
 * The RPC and MCP sides read the service optionally, so neither adds it to the
 * requirements of every server test that builds those layers.
 */
export const withService = <A>(
  use: (initiatives: InitiativesShape) => Effect.Effect<A, InitiativesError>,
) =>
  Effect.flatMap(Effect.serviceOption(Initiatives), (initiatives) =>
    Option.isSome(initiatives)
      ? use(initiatives.value)
      : Effect.fail(failure("This server does not keep initiatives.")),
  );

export const subscribeListRpc = () =>
  Stream.unwrap(withService((initiatives) => Effect.succeed(initiatives.subscribeList)));

export const subscribeDetailRpc = (input: { readonly initiativeId: string }) =>
  Stream.unwrap(
    withService((initiatives) => Effect.succeed(initiatives.subscribeDetail(input.initiativeId))),
  );

export const actRpc = (action: InitiativesAction, author: InitiativeAuthor) =>
  withService((initiatives) => initiatives.act(action, author));

export const usageRpc = (input: { readonly initiativeId: string }) =>
  withService((initiatives) => initiatives.usage(input.initiativeId));

export const brainReadRpc = (input: { readonly initiativeId: string; readonly path: string }) =>
  withService((initiatives) => initiatives.brain.read(input.initiativeId, input.path));
