// @effect-diagnostics nodeBuiltinImport:off -- The restart script must outlive this process, which needs a detached, unref'd Node child.
/**
 * Private-fork replacement for the updater. The fork app runs from a prebuilt
 * slot (`<root>/current`); `scripts/fork-app.sh prepare` builds a checkout
 * into `<root>/builds/<branch>`, replacing that branch's older build, and
 * `prepare-server` builds a t3 runtime for the background service when the
 * server changed, recorded in `<root>/servers/<branch>.json`. Every minute
 * this runs `fork-app.sh watch`, which does both for new commits on
 * `origin/fork`.
 *
 * Every waiting build is reported in `forkBuilds`; the update menu installs
 * or deletes one by branch. Installing runs `fork-app.sh restart <branch>`
 * and, when the branch's server differs from the one the service runs,
 * `fork-app.sh restart-service <version>` side by side. Threads, subagents
 * and workflows continue after the service restart, so there is nothing to
 * confirm. The plain `install` of the updater interface (menu bar, settings)
 * takes the fork branch's build, else the newest one.
 *
 * Active only when `T3CODE_FORK_APP_ROOT` and `T3CODE_FORK_APP_SCRIPT` are set;
 * otherwise the regular updater is used.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  DesktopForkBuild,
  DesktopForkBuildAction,
  DesktopForkServiceState,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const POLL_INTERVAL = Duration.seconds(5);
const WATCH_INTERVAL = Duration.minutes(1);
const WATCH_LOG_MAX_BYTES = 5 * 1024 * 1024;
const RUNTIME_DIR = NodePath.join(NodeOS.homedir(), ".t3", "runtime");
// `update` restarts the service beside the app, so the relaunched app finds
// the restart still pending for a few seconds; that is not an update to offer.
const SERVICE_RESTART_GRACE_MS = 2 * 60 * 1000;
/** The branch the app follows on its own; its build leads the list. */
const MAIN_BRANCH_SLUG = "fork";

export class ForkAppBuilds extends Context.Service<
  ForkAppBuilds,
  {
    readonly act: (action: DesktopForkBuildAction) => Effect.Effect<DesktopUpdateActionResult>;
  }
>()("@t3tools/desktop/updates/ForkAppUpdates/ForkAppBuilds") {}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(json: Record<string, unknown> | null, field: string): string | null {
  const value = json?.[field];
  return typeof value === "string" && value !== "" ? value : null;
}

interface ForkBuildInfo {
  readonly label: string;
  readonly branch: string;
  readonly commit: string;
  readonly builtAt: string;
  readonly dirty: boolean;
  readonly sizeBytes: number | null;
}

/** Builds before slots were per branch carry only a label, which starts with the branch. */
function readBuildInfo(slotDir: string): ForkBuildInfo | null {
  const json = readJson(NodePath.join(slotDir, ".fork-build.json"));
  const label = stringField(json, "label");
  if (label === null) return null;
  return {
    label,
    branch: stringField(json, "branch") ?? label.split("@")[0] ?? label,
    commit: stringField(json, "commit") ?? "",
    builtAt: stringField(json, "builtAt") ?? "",
    dirty: json?.dirty === true,
    sizeBytes: typeof json?.sizeBytes === "number" ? json.sizeBytes : null,
  };
}

/**
 * The service is behind when a switch was written but its restart has not
 * happened. `activeVersion` is what the launcher starts next; it deletes
 * `.restart-pending` once it has, so a switch whose restart failed stays
 * pending, running the version it had before.
 */
export function resolveForkServiceVersions(input: {
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  readonly restartPending: boolean;
}) {
  return {
    runningVersion: input.restartPending ? input.previousVersion : input.activeVersion,
    pendingVersion: input.restartPending ? input.activeVersion : null,
  };
}

/**
 * The server a branch's build brings along: its newest server built, when the
 * service does not run it yet (or has a restart onto it still pending).
 */
export function resolveForkBuildServer(input: {
  readonly builtVersion: string | null;
  readonly blockedReason: string | null;
  readonly activeVersion: string | null;
  readonly restartPending: boolean;
}): Pick<DesktopForkBuild, "serverVersion" | "serverBlocked"> {
  const { builtVersion, blockedReason, activeVersion, restartPending } = input;
  if (builtVersion === null) return { serverVersion: null, serverBlocked: null };
  if (blockedReason !== null) return { serverVersion: null, serverBlocked: blockedReason };
  return {
    serverVersion: builtVersion !== activeVersion || restartPending ? builtVersion : null,
    serverBlocked: null,
  };
}

/** The fork branch's build first, then the rest newest first. */
export function sortForkBuilds<T extends Pick<DesktopForkBuild, "slug" | "builtAt">>(
  builds: ReadonlyArray<T>,
): Array<T> {
  return [...builds].sort((a, b) => {
    if (a.slug === MAIN_BRANCH_SLUG) return b.slug === MAIN_BRANCH_SLUG ? 0 : -1;
    if (b.slug === MAIN_BRANCH_SLUG) return 1;
    return b.builtAt.localeCompare(a.builtAt);
  });
}

/**
 * What the one-button paths (menu bar, settings) install: the leading build,
 * else a service restart that is still pending. Null when nothing waits.
 */
export function resolveForkUpdateOffer(input: {
  readonly builds: ReadonlyArray<DesktopForkBuild>;
  readonly service: Pick<DesktopForkServiceState, "pendingVersion" | "blockedReason">;
}): { readonly label: string; readonly build: DesktopForkBuild | null } | null {
  const build = sortForkBuilds(input.builds)[0];
  if (build !== undefined) return { label: build.label, build };
  const { pendingVersion, blockedReason } = input.service;
  return pendingVersion !== null && blockedReason === null
    ? { label: pendingVersion, build: null }
    : null;
}

/** A restart the launcher has not completed after its grace period. */
function restartPendingSince(now: number): boolean {
  try {
    const { mtimeMs } = NodeFS.statSync(NodePath.join(RUNTIME_DIR, ".restart-pending"));
    return now - mtimeMs > SERVICE_RESTART_GRACE_MS;
  } catch {
    return false;
  }
}

function readForkState(root: string, now: number) {
  const activeVersion = stringField(
    readJson(NodePath.join(RUNTIME_DIR, "service-state.json")),
    "activeVersion",
  );
  let previousVersion: string | null = null;
  try {
    previousVersion =
      NodeFS.readFileSync(NodePath.join(RUNTIME_DIR, ".fork-previous-version"), "utf8").trim() ||
      null;
  } catch {
    // Never switched.
  }
  const restartPending = restartPendingSince(now);
  const service: DesktopForkServiceState = {
    ...resolveForkServiceVersions({ activeVersion, previousVersion, restartPending }),
    blockedReason: null,
  };

  const buildsDir = NodePath.join(root, "builds");
  let slugs: string[] = [];
  try {
    slugs = NodeFS.readdirSync(buildsDir);
  } catch {
    // Nothing prepared yet.
  }
  const builds: DesktopForkBuild[] = [];
  for (const slug of slugs) {
    const info = readBuildInfo(NodePath.join(buildsDir, slug));
    if (info === null) continue;
    const server = readJson(NodePath.join(root, "servers", `${slug}.json`));
    builds.push({
      slug,
      ...info,
      ...resolveForkBuildServer({
        builtVersion: stringField(server, "version"),
        blockedReason: stringField(server, "blocked"),
        activeVersion,
        restartPending,
      }),
    });
  }
  return { service, builds: sortForkBuilds(builds) };
}

function scriptEnv() {
  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

/** Runs a fork-app.sh command to completion; resolves with its exit code. */
function runScript(script: string, args: readonly string[], logPath: string) {
  return Effect.callback<number>((resume) => {
    let log: number;
    try {
      log = NodeFS.openSync(logPath, "a");
    } catch {
      resume(Effect.succeed(-1));
      return;
    }
    const child = NodeChildProcess.spawn(script, args, {
      stdio: ["ignore", log, log],
      env: scriptEnv(),
    });
    const done = (code: number) => {
      NodeFS.closeSync(log);
      resume(Effect.succeed(code));
    };
    child.once("error", () => done(-1));
    child.once("exit", (code) => done(code ?? -1));
  });
}

export const makeForkUpdates = (input: { readonly root: string; readonly script: string }) =>
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;

    const currentLabel =
      readBuildInfo(NodePath.join(input.root, "current"))?.label ?? environment.appVersion;
    const baseState: DesktopUpdateState = {
      ...createInitialDesktopUpdateState(
        currentLabel,
        environment.runtimeInfo,
        environment.defaultDesktopSettings.updateChannel,
      ),
      enabled: true,
      status: "idle",
    };

    const stateRef = yield* Ref.make(baseState);
    const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
    const stateMutex = yield* Semaphore.make(1);
    const installingRef = yield* Ref.make(false);

    const emitState = Ref.get(stateRef).pipe(
      Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
    );

    const setState = (next: DesktopUpdateState) =>
      stateMutex
        .withPermits(1)(
          Ref.get(stateRef).pipe(
            Effect.flatMap((previous) =>
              JSON.stringify(previous) === JSON.stringify(next)
                ? Effect.void
                : Ref.set(stateRef, next).pipe(
                    Effect.andThen(PubSub.publish(stateChanges, next)),
                    Effect.andThen(emitState),
                  ),
            ),
          ),
        )
        .pipe(Effect.as(next));

    /** Reflects the waiting builds and where the service stands. */
    const refresh = (checked: boolean) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const now = yield* DateTime.now;
        const checkedAt = checked ? DateTime.formatIso(now) : state.checkedAt;
        const { service, builds } = readForkState(input.root, DateTime.toEpochMillis(now));
        const offer = resolveForkUpdateOffer({ builds, service });
        return yield* setState(
          offer !== null
            ? {
                ...state,
                status: "downloaded",
                availableVersion: offer.label,
                downloadedVersion: offer.label,
                checkedAt,
                message: null,
                errorContext: null,
                forkService: service,
                forkBuilds: builds,
              }
            : {
                ...state,
                status: checked
                  ? "up-to-date"
                  : state.status === "up-to-date"
                    ? "up-to-date"
                    : "idle",
                availableVersion: null,
                downloadedVersion: null,
                checkedAt,
                message: null,
                errorContext: null,
                forkService: service,
                forkBuilds: builds,
              },
        );
      });

    const logDir = NodePath.join(input.root, "logs");
    const watchLog = NodePath.join(logDir, "fork-watch.log");
    const appLog = NodePath.join(logDir, "fork-app.log");

    // One pass at a time; a build takes minutes, so passes queue up otherwise.
    const watchMutex = yield* Semaphore.make(1);
    const watchPass = watchMutex.withPermitsIfAvailable(1)(
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          NodeFS.mkdirSync(logDir, { recursive: true });
          try {
            if (NodeFS.statSync(watchLog).size > WATCH_LOG_MAX_BYTES) {
              NodeFS.renameSync(watchLog, `${watchLog}.1`);
            }
          } catch {
            // No log yet.
          }
        });
        yield* runScript(input.script, ["watch"], watchLog);
        yield* refresh(false);
      }),
    );

    const installFailure = (message: string) =>
      Effect.gen(function* () {
        yield* Ref.set(installingRef, false);
        const state = yield* Ref.get(stateRef);
        const next = yield* setState({
          ...state,
          status: "error",
          errorContext: "install",
          message,
          canRetry: true,
        });
        return { accepted: true, completed: false, state: next };
      });

    /** Switches to a build (the leading one when none is named) and relaunches. */
    const install = (slug: string | null) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const builds = state.forkBuilds ?? [];
        const service = state.forkService ?? {
          runningVersion: null,
          pendingVersion: null,
          blockedReason: null,
        };
        const target =
          slug !== null
            ? (builds.find((build) => build.slug === slug) ?? null)
            : (resolveForkUpdateOffer({ builds, service })?.build ?? null);
        if (slug !== null && target === null) {
          return { accepted: false, completed: false, state };
        }
        const serverVersion =
          target !== null
            ? target.serverVersion
            : service.blockedReason === null
              ? service.pendingVersion
              : null;
        if (target === null && serverVersion === null) {
          return { accepted: false, completed: false, state };
        }
        yield* Ref.set(installingRef, true);
        const failed = yield* Effect.sync(() => {
          // Detached so the scripts outlive this process when `restart` stops the app.
          const spawnDetached = (args: readonly string[], log: number | "ignore") => {
            const child = NodeChildProcess.spawn(input.script, args, {
              detached: true,
              stdio: ["ignore", log, log],
              env: scriptEnv(),
            });
            child.unref();
          };
          try {
            if (serverVersion !== null) {
              NodeFS.mkdirSync(logDir, { recursive: true });
              const log = NodeFS.openSync(appLog, "a");
              try {
                spawnDetached(["restart-service", serverVersion], log);
              } finally {
                NodeFS.closeSync(log);
              }
            }
            if (target !== null) spawnDetached(["restart", target.slug], "ignore");
            return false;
          } catch {
            return true;
          }
        });
        if (failed) return yield* installFailure(`Could not run ${input.script}`);
        // Only an app restart ends this process; a service-only switch keeps
        // it running, so it must not stay marked as installing.
        if (target === null) yield* Ref.set(installingRef, false);
        return { accepted: true, completed: true, state: yield* Ref.get(stateRef) };
      });

    /** Removes a branch's build and server; the list refreshes right after. */
    const remove = (slug: string) =>
      Effect.gen(function* () {
        const known = yield* Ref.get(stateRef);
        if (!(known.forkBuilds ?? []).some((build) => build.slug === slug)) {
          return { accepted: false, completed: false, state: known };
        }
        yield* Effect.sync(() => NodeFS.mkdirSync(logDir, { recursive: true }));
        const code = yield* runScript(input.script, ["delete", slug], appLog);
        const state = yield* refresh(false);
        return code === 0
          ? { accepted: true, completed: true, state }
          : {
              accepted: true,
              completed: false,
              state: { ...state, message: `Could not remove the build of ${slug}` },
            };
      });

    const updates = DesktopUpdates.DesktopUpdates.of({
      getState: Ref.get(stateRef),
      isActionActive: Ref.get(installingRef),
      isInstallActive: Ref.get(installingRef),
      subscribe: stateMutex.withPermits(1)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(stateChanges);
          const latest = yield* Ref.get(stateRef);
          return { latest, changes: Stream.fromSubscription(subscription) };
        }),
      ),
      emitState,
      disabledReason: Effect.succeed(Option.none()),
      configure: Effect.all([
        refresh(false).pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.forkScoped),
        watchPass.pipe(Effect.repeat(Schedule.spaced(WATCH_INTERVAL)), Effect.forkScoped),
      ]).pipe(Effect.asVoid),
      setChannel: () => Ref.get(stateRef),
      // Starts a fetch without waiting for the build it may lead to.
      check: () =>
        watchPass.pipe(
          Effect.forkDetach,
          Effect.andThen(refresh(true)),
          Effect.map((state) => ({ checked: true, state })),
        ),
      download: refresh(true).pipe(
        Effect.map((state) => ({ accepted: false, completed: false, state })),
      ),
      install: install(null),
      installPrepared: () =>
        install(null).pipe(Effect.map((result) => ({ ...result, failed: !result.completed }))),
    });
    const builds = ForkAppBuilds.of({
      act: (action) => (action.kind === "install" ? install(action.slug) : remove(action.slug)),
    });
    return Context.make(DesktopUpdates.DesktopUpdates, updates).pipe(
      Context.add(ForkAppBuilds, builds),
    );
  });

/** Without the fork launcher there are no branch builds to act on. */
const noForkBuilds = Layer.effect(
  ForkAppBuilds,
  Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return ForkAppBuilds.of({
      act: () =>
        updates.getState.pipe(
          Effect.map((state) => ({ accepted: false, completed: false, state })),
        ),
    });
  }),
);

/** Uses the fork updater when the fork launcher configured it, else the real one. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    if (Option.isSome(config.forkAppRoot) && Option.isSome(config.forkAppScript)) {
      return Layer.effectContext(
        makeForkUpdates({
          root: config.forkAppRoot.value,
          script: config.forkAppScript.value,
        }),
      );
    }
    return Layer.provideMerge(noForkBuilds, DesktopUpdates.layer);
  }),
);
