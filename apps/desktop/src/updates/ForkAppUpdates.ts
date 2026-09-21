// @effect-diagnostics nodeBuiltinImport:off -- The restart script must outlive this process, which needs a detached, unref'd Node child.
/**
 * Private-fork replacement for the updater. The fork app runs from a prebuilt
 * slot (`<root>/current`); `scripts/fork-app.sh prepare` builds the next
 * version into `<root>/next`, and `prepare-server` builds a t3 runtime for the
 * background service when the server changed. Every minute this runs
 * `fork-app.sh watch`, which does both for new commits on `origin/fork`.
 *
 * The two halves update separately, because only the service restart ends
 * agent sessions: the prepared app is reported as a downloaded update, whose
 * "install" hands off to `fork-app.sh restart`, and a pending server rides
 * along as `forkService`, switched to by `ForkServiceUpdates.restart`.
 *
 * Active only when `T3CODE_FORK_APP_ROOT` and `T3CODE_FORK_APP_SCRIPT` are set;
 * otherwise the regular updater is used.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DesktopForkServiceState, DesktopUpdateState } from "@t3tools/contracts";
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

interface ForkBuildInfo {
  readonly label: string;
}

function readBuildInfo(slotDir: string): ForkBuildInfo | null {
  try {
    const raw = NodeFS.readFileSync(NodePath.join(slotDir, ".fork-build.json"), "utf8");
    const parsed = JSON.parse(raw) as { label?: unknown };
    return typeof parsed.label === "string" ? { label: parsed.label } : null;
  } catch {
    return null;
  }
}

function readJsonField(path: string, field: string): string | null {
  try {
    const value = (JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>)[field];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The service is behind when the newest fork server is not the one it runs.
 * `activeVersion` is what the launcher starts next; it deletes
 * `.restart-pending` once it has, so a switch whose restart failed stays
 * pending, running the version it had before.
 */
export function resolveForkServiceVersions(input: {
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  readonly restartPending: boolean;
  readonly builtVersion: string | null;
}) {
  const { activeVersion, builtVersion, restartPending } = input;
  return {
    runningVersion: restartPending ? input.previousVersion : activeVersion,
    pendingVersion:
      builtVersion !== null && (builtVersion !== activeVersion || restartPending)
        ? builtVersion
        : restartPending
          ? activeVersion
          : null,
  };
}

function readServiceVersions(root: string) {
  const serverInfo = NodePath.join(root, "server.json");
  let previousVersion: string | null = null;
  try {
    previousVersion =
      NodeFS.readFileSync(NodePath.join(RUNTIME_DIR, ".fork-previous-version"), "utf8").trim() ||
      null;
  } catch {
    // Never switched.
  }
  return {
    ...resolveForkServiceVersions({
      activeVersion: readJsonField(
        NodePath.join(RUNTIME_DIR, "service-state.json"),
        "activeVersion",
      ),
      previousVersion,
      restartPending: NodeFS.existsSync(NodePath.join(RUNTIME_DIR, ".restart-pending")),
      builtVersion: readJsonField(serverInfo, "version"),
    }),
    blockedReason: readJsonField(serverInfo, "blocked"),
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
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });
    const done = (code: number) => {
      NodeFS.closeSync(log);
      resume(Effect.succeed(code));
    };
    child.once("error", () => done(-1));
    child.once("exit", (code) => done(code ?? -1));
  });
}

function lastLines(path: string, count: number): string {
  try {
    return NodeFS.readFileSync(path, "utf8").trimEnd().split("\n").slice(-count).join("\n");
  } catch {
    return "";
  }
}

/** Present in fork builds only: restarts the t3 service on the pending server. */
export class ForkServiceUpdates extends Context.Service<
  ForkServiceUpdates,
  { readonly restart: Effect.Effect<DesktopUpdateState> }
>()("@t3tools/desktop/updates/ForkAppUpdates/ForkServiceUpdates") {}

const makeForkUpdates = (input: { readonly root: string; readonly script: string }) =>
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
    const serviceRestartRef = yield* Ref.make<{ restarting: boolean; error: string | null }>({
      restarting: false,
      error: null,
    });
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

    /** Reflects the prepared app build in `next` and where the service stands. */
    const refresh = (checked: boolean) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const prepared = readBuildInfo(NodePath.join(input.root, "next"));
        const checkedAt = checked ? DateTime.formatIso(yield* DateTime.now) : state.checkedAt;
        const forkService: DesktopForkServiceState = {
          ...readServiceVersions(input.root),
          ...(yield* Ref.get(serviceRestartRef)),
        };
        return yield* setState(
          prepared
            ? {
                ...state,
                status: "downloaded",
                availableVersion: prepared.label,
                downloadedVersion: prepared.label,
                checkedAt,
                message: null,
                errorContext: null,
                forkService,
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
                forkService,
              },
        );
      });

    const logDir = NodePath.join(input.root, "logs");
    const watchLog = NodePath.join(logDir, "fork-watch.log");
    const serviceLog = NodePath.join(logDir, "fork-app.log");

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

    const restartService = Effect.gen(function* () {
      const current = yield* Ref.get(serviceRestartRef);
      if (current.restarting) return yield* Ref.get(stateRef);
      yield* Ref.set(serviceRestartRef, { restarting: true, error: null });
      yield* refresh(false);
      const code = yield* runScript(input.script, ["restart-service"], serviceLog);
      yield* Ref.set(serviceRestartRef, {
        restarting: false,
        error:
          code === 0
            ? null
            : lastLines(serviceLog, 3) || `fork-app.sh restart-service exited with ${code}`,
      });
      return yield* refresh(false);
    });

    const install = Effect.gen(function* () {
      yield* Ref.set(installingRef, true);
      const failed = yield* Effect.sync(() => {
        try {
          // Detached so the script outlives this process when it stops the app.
          const child = NodeChildProcess.spawn(input.script, ["restart"], {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin:/usr/sbin:/sbin`,
            },
          });
          child.unref();
          return false;
        } catch {
          return true;
        }
      });
      if (failed) {
        yield* Ref.set(installingRef, false);
        const state = yield* Ref.get(stateRef);
        const next = yield* setState({
          ...state,
          status: "error",
          errorContext: "install",
          message: `Could not run ${input.script}`,
          canRetry: true,
        });
        return { accepted: true, completed: false, state: next };
      }
      return { accepted: true, completed: true, state: yield* Ref.get(stateRef) };
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
      install,
      installPrepared: () =>
        install.pipe(Effect.map((result) => ({ ...result, failed: !result.completed }))),
    });
    return { updates, service: ForkServiceUpdates.of({ restart: restartService }) };
  });

/** Uses the fork updater when the fork launcher configured it, else the real one. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    if (Option.isSome(config.forkAppRoot) && Option.isSome(config.forkAppScript)) {
      return Layer.effectContext(
        makeForkUpdates({
          root: config.forkAppRoot.value,
          script: config.forkAppScript.value,
        }).pipe(
          Effect.map(({ updates, service }) =>
            Context.make(DesktopUpdates.DesktopUpdates, updates).pipe(
              Context.add(ForkServiceUpdates, service),
            ),
          ),
        ),
      );
    }
    return DesktopUpdates.layer;
  }),
);
