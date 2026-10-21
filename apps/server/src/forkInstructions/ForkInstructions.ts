/**
 * Fork: the instruction files of the Instructions tab.
 *
 * The server works out every path from the thread: Project is the thread's
 * checkout (its worktree, else the project root), Global the provider's home
 * as the thread's provider instance runs it (`homePath`, `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`). See `instructionFiles.ts` for which file that is.
 */
import {
  ForkInstructionsConflictError,
  ForkInstructionsError,
  type ForkInstructionsSnapshot,
  type ForkInstructionsTarget,
  type ForkInstructionsWriteInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readSnapshot, resolveLocation, writeFile } from "./instructionFiles.ts";
import { threadRoots } from "./threadRoots.ts";

export class ForkInstructions extends Context.Service<
  ForkInstructions,
  {
    readonly read: (
      target: ForkInstructionsTarget,
    ) => Effect.Effect<ForkInstructionsSnapshot, ForkInstructionsError>;
    readonly write: (
      input: ForkInstructionsWriteInput,
    ) => Effect.Effect<
      ForkInstructionsSnapshot,
      ForkInstructionsError | ForkInstructionsConflictError
    >;
  }
>()("t3/forkInstructions/ForkInstructions") {}

const failure = (message: string) => new ForkInstructionsError({ message });

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettingsService;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const writes = yield* Semaphore.make(1);

  /** The thread's provider (unless the target names one) and where its files live. */
  const resolve = Effect.fn("ForkInstructions.resolve")(function* (target: ForkInstructionsTarget) {
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const thread = yield* projections
      .getThread(target.threadId)
      .pipe(Effect.mapError(() => failure("The thread was not found.")));
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => failure("Could not read the server settings.")),
    );
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(() => failure("Could not read the thread's project.")));
    const checkout = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot ?? null;
    if (checkout === null) return yield* failure("The thread's project was not found.");
    const { provider, roots } = yield* threadRoots({
      provider: target.provider,
      threadInstanceId: thread.providerInstanceId,
      checkout,
      providerInstances: settings.providerInstances,
      environment,
      home,
    });
    return { home, location: yield* resolveLocation(provider, target.scope, roots) };
  });

  const read: ForkInstructions["Service"]["read"] = (target) =>
    Effect.gen(function* () {
      const { home, location } = yield* resolve(target);
      return yield* readSnapshot(location, home, target.file);
    }).pipe(Effect.provide(context));

  const write: ForkInstructions["Service"]["write"] = (input) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const { home, location } = yield* resolve(input);
        return yield* writeFile(location, home, input);
      }).pipe(Effect.provide(context)),
    );

  return ForkInstructions.of({ read, write });
});

export const layer = Layer.effect(ForkInstructions, make);

/** Read optionally, like ForkNotes, so server tests that build the RPC layer need not provide it. */
const withService = <A, E>(
  use: (service: ForkInstructions["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E | ForkInstructionsError> =>
  Effect.flatMap(
    Effect.serviceOption(ForkInstructions),
    (service): Effect.Effect<A, E | ForkInstructionsError> =>
      Option.isSome(service)
        ? use(service.value)
        : Effect.fail(failure("This server does not edit instruction files.")),
  );

export const readRpc = (target: ForkInstructionsTarget) =>
  withService((service) => service.read(target));

export const writeRpc = (input: ForkInstructionsWriteInput) =>
  withService((service) => service.write(input));
