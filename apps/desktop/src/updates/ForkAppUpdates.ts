// @effect-diagnostics nodeBuiltinImport:off -- The restart script must outlive this process, which needs a detached, unref'd Node child.
/**
 * Private-fork replacement for the updater. The fork app runs from a prebuilt
 * slot (`<root>/current`); `scripts/fork-app.sh prepare` builds the next
 * version into `<root>/next`, and `prepare-server` builds a t3 runtime for the
 * background service when the server changed. Every minute this runs
 * `fork-app.sh watch`, which does both for new commits on `origin/fork`.
 *
 * A prepared app or a pending server is reported as one downloaded update,
 * whose "install" runs `fork-app.sh restart-service` and `fork-app.sh restart`
 * side by side. Both commands predate the single button, so a checkout whose
 * script was not updated with the app still installs everything. Threads, subagents and workflows
 * continue after the service restart, so there is nothing to confirm.
 *
 * Active only when `T3CODE_FORK_APP_ROOT` and `T3CODE_FORK_APP_SCRIPT` are set;
 * otherwise the regular updater is used.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DesktopForkServiceState, DesktopUpdateState } from "@t3tools/contracts";
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

/** A restart the launcher has not completed after its grace period. */
function restartPendingSince(now: number): boolean {
  try {
    const { mtimeMs } = NodeFS.statSync(NodePath.join(RUNTIME_DIR, ".restart-pending"));
    return now - mtimeMs > SERVICE_RESTART_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * The one update the app offers: the prepared app build, else the server the
 * service is waiting to switch to. Null when neither is pending.
 */
export function resolveForkUpdateLabel(input: {
  readonly preparedApp: string | null;
  readonly service: Pick<DesktopForkServiceState, "pendingVersion" | "blockedReason">;
}): string | null {
  if (input.preparedApp !== null) return input.preparedApp;
  const { pendingVersion, blockedReason } = input.service;
  return pendingVersion !== null && blockedReason === null ? pendingVersion : null;
}

function readServiceVersions(root: string, now: number) {
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
      restartPending: restartPendingSince(now),
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
        const now = yield* DateTime.now;
        const checkedAt = checked ? DateTime.formatIso(now) : state.checkedAt;
        const forkService: DesktopForkServiceState = readServiceVersions(
          input.root,
          DateTime.toEpochMillis(now),
        );
        const label = resolveForkUpdateLabel({
          preparedApp: readBuildInfo(NodePath.join(input.root, "next"))?.label ?? null,
          service: forkService,
        });
        return yield* setState(
          label !== null
            ? {
                ...state,
                status: "downloaded",
                availableVersion: label,
                downloadedVersion: label,
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

    const install = Effect.gen(function* () {
      yield* Ref.set(installingRef, true);
      const service = (yield* Ref.get(stateRef)).forkService;
      const restartService =
        service !== undefined && service.pendingVersion !== null && service.blockedReason === null;
      const failed = yield* Effect.sync(() => {
        // Detached so the scripts outlive this process when `restart` stops the app.
        const spawnDetached = (command: string, log: number | "ignore") => {
          const child = NodeChildProcess.spawn(input.script, [command], {
            detached: true,
            stdio: ["ignore", log, log],
            env: {
              ...process.env,
              PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin:/usr/sbin:/sbin`,
            },
          });
          child.unref();
        };
        try {
          if (restartService) {
            NodeFS.mkdirSync(logDir, { recursive: true });
            const log = NodeFS.openSync(appLog, "a");
            try {
              spawnDetached("restart-service", log);
            } finally {
              NodeFS.closeSync(log);
            }
          }
          spawnDetached("restart", "ignore");
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
    return updates;
  });

/** Uses the fork updater when the fork launcher configured it, else the real one. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    if (Option.isSome(config.forkAppRoot) && Option.isSome(config.forkAppScript)) {
      return Layer.effect(
        DesktopUpdates.DesktopUpdates,
        makeForkUpdates({
          root: config.forkAppRoot.value,
          script: config.forkAppScript.value,
        }),
      );
    }
    return DesktopUpdates.layer;
  }),
);
