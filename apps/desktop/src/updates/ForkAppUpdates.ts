// @effect-diagnostics nodeBuiltinImport:off -- The restart script must outlive this process, which needs a detached, unref'd Node child.
/**
 * Private-fork replacement for the updater. The fork app runs from a prebuilt
 * slot (`<root>/current`); agents build the next version into `<root>/next`
 * with `scripts/fork-app.sh prepare`. This service reports that prepared build
 * as a downloaded update, and "install" hands off to `fork-app.sh restart`,
 * which swaps the slots and relaunches the app.
 *
 * Active only when `T3CODE_FORK_APP_ROOT` and `T3CODE_FORK_APP_SCRIPT` are set;
 * otherwise the regular updater is used.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopUpdateState } from "@t3tools/contracts";
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

    /** Reflects whether a prepared build is waiting in the `next` slot. */
    const refresh = (checked: boolean) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const prepared = readBuildInfo(NodePath.join(input.root, "next"));
        const checkedAt = checked ? DateTime.formatIso(yield* DateTime.now) : state.checkedAt;
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
              },
        );
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

    return DesktopUpdates.DesktopUpdates.of({
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
      configure: refresh(false).pipe(
        Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
        Effect.forkScoped,
        Effect.asVoid,
      ),
      setChannel: () => Ref.get(stateRef),
      check: () => refresh(true).pipe(Effect.map((state) => ({ checked: true, state }))),
      download: refresh(true).pipe(
        Effect.map((state) => ({ accepted: false, completed: false, state })),
      ),
      install,
      installPrepared: () =>
        install.pipe(Effect.map((result) => ({ ...result, failed: !result.completed }))),
    });
  });

/** Uses the fork updater when the fork launcher configured it, else the real one. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    if (Option.isSome(config.forkAppRoot) && Option.isSome(config.forkAppScript)) {
      return Layer.effect(
        DesktopUpdates.DesktopUpdates,
        makeForkUpdates({ root: config.forkAppRoot.value, script: config.forkAppScript.value }),
      );
    }
    return DesktopUpdates.layer;
  }),
);
