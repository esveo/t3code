/**
 * Fork: the initiatives' ThreadBridge on today's orchestration (V1). It starts
 * threads through the same starter as a coordinator's start_thread and reads
 * them from the projection. Orchestration V2 gets its own adapter.
 */
import {
  isProviderAvailable,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { type ThreadBridge, ThreadBridgeError } from "@t3tools/initiatives/bridge";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { chooseModelSelection } from "../mcp/toolkits/threads/modelChoice.ts";
import { makeThreadStarter } from "../mcp/toolkits/threads/threadStarter.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";

const bridgeError =
  (detail: string) =>
  <E>(cause: Cause.Cause<E>) => {
    const squashed = Cause.squash(cause);
    const message =
      squashed instanceof Error ? squashed.message : typeof squashed === "string" ? squashed : "";
    return Effect.fail(
      new ThreadBridgeError({ message: message ? `${detail}: ${message}` : detail }),
    );
  };

const isUsable = (provider: ServerProvider) =>
  provider.enabled && provider.status !== "disabled" && isProviderAvailable(provider);

/** The model the composer would pick for a provider when none is named. */
const defaultSelectionOf = (provider: ServerProvider): ModelSelection => ({
  instanceId: provider.instanceId,
  model:
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom && !model.isLegacy)?.slug ??
    provider.models[0]?.slug ??
    "default",
});

export const makeThreadBridgeV1 = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const starter = yield* makeThreadStarter;

  const findThread = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.catchCause(bridgeError("Could not read the thread")));

  const findProject = (projectId: string) =>
    snapshots.getProjectShells().pipe(
      Effect.catchCause(bridgeError("Could not read the projects")),
      Effect.flatMap((projects) => {
        const project = projects.find((candidate) => candidate.id === projectId);
        return project
          ? Effect.succeed(project)
          : Effect.fail(new ThreadBridgeError({ message: `Project ${projectId} was not found.` }));
      }),
    );

  const bridge: ThreadBridge = {
    capabilities: {
      runtimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
      lineage: "one-level",
    },

    resolveModel: (input) =>
      Effect.gen(function* () {
        const providers = yield* providerRegistry.getProviders;
        const project = yield* findProject(input.projectId);
        const parent = input.parentThreadId
          ? Option.getOrNull(yield* findThread(input.parentThreadId))
          : null;
        const fallbackProvider = providers.find(isUsable);
        const current =
          parent?.modelSelection ??
          project.defaultModelSelection ??
          (fallbackProvider ? defaultSelectionOf(fallbackProvider) : null);
        if (current === null && input.provider === null) {
          return yield* new ThreadBridgeError({
            message: "No provider is ready. Set one up in Settings, then start the thread again.",
          });
        }
        const chosen = chooseModelSelection({
          providers,
          current: current ?? {
            instanceId: ProviderInstanceId.make(input.provider!),
            model: "default",
          },
          provider: input.provider ?? undefined,
          model: input.model ?? undefined,
        });
        if ("error" in chosen) return yield* new ThreadBridgeError({ message: chosen.error });
        const entry = providers.find(
          (candidate) => candidate.instanceId === chosen.selection.instanceId,
        );
        return { modelSelection: chosen.selection, driver: entry?.driver ?? null };
      }),

    startThread: (job, prompt) =>
      Effect.gen(function* () {
        const project = yield* findProject(job.spec.projectId);
        const parent = job.spec.parentThreadId
          ? Option.getOrNull(yield* findThread(job.spec.parentThreadId))
          : null;
        const checkout = yield* starter.checkout({
          parent,
          project,
          worktree: job.spec.worktree,
          baseBranch: job.spec.baseBranch ?? undefined,
        });
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make(job.spec.provider ?? "codex"),
          model: job.spec.model ?? "default",
        };
        return yield* starter.start({
          checkout,
          threadId: job.threadId,
          parentThreadId: parent?.id ?? null,
          title: job.spec.title,
          text: prompt,
          attachments: [],
          modelSelection,
          runtimeMode: job.spec.runtimeMode,
        });
      }).pipe(
        Effect.catchTag("ThreadOrchestrationFailedError", (error) =>
          Effect.fail(new ThreadBridgeError({ message: error.detail })),
        ),
      ),

    findThread,

    listThreads: () =>
      snapshots.getShellSnapshot().pipe(
        Effect.map((snapshot) => snapshot.threads),
        Effect.catchCause(bridgeError("Could not list the threads")),
      ),

    listProjects: () =>
      snapshots.getProjectShells().pipe(
        Effect.map((projects) =>
          projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        ),
        Effect.catchCause(bridgeError("Could not read the projects")),
      ),
  };
  return bridge;
});
