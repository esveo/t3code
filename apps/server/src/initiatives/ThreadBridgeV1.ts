/**
 * Fork: the initiatives' ThreadBridge on today's orchestration (V1). It starts
 * threads through the same starter as a coordinator's start_thread and reads
 * them from the projection. Orchestration V2 gets its own adapter.
 */
import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { type ThreadBridge, ThreadBridgeError } from "@t3tools/initiatives/bridge";
import { resolveChildThreadState } from "@t3tools/shared/threadOrchestration";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { chooseModelSelection } from "../mcp/toolkits/threads/modelChoice.ts";
import { makeThreadStarter } from "../mcp/toolkits/threads/threadStarter.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
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
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:initiatives-${tag}:${id}`));
  const dispatch = (
    command: Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[0],
  ) =>
    engine
      .dispatch(command)
      .pipe(Effect.asVoid, Effect.catchCause(bridgeError(`Could not ${command.type}`)));

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

    ensureProject: (input) =>
      Effect.gen(function* () {
        const existing = yield* snapshots
          .getActiveProjectByWorkspaceRoot(input.workspaceRoot)
          .pipe(Effect.catchCause(bridgeError("Could not read the projects")));
        if (Option.isSome(existing)) {
          const project = existing.value;
          return {
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          };
        }
        const projectId = ProjectId.make(yield* uuid);
        yield* dispatch({
          type: "project.create",
          commandId: yield* commandId("project"),
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          createWorkspaceRootIfMissing: true,
          createdAt: yield* nowIso,
        });
        return { projectId, title: input.title, workspaceRoot: input.workspaceRoot };
      }),

    setPinned: (threadId, pinned) =>
      Effect.gen(function* () {
        const thread = yield* findThread(threadId);
        if (Option.isNone(thread) || (thread.value.pinnedAt != null) === pinned) return;
        yield* dispatch(
          pinned
            ? { type: "thread.pin", commandId: yield* commandId("pin"), threadId }
            : { type: "thread.unpin", commandId: yield* commandId("unpin"), threadId },
        );
      }),

    sendMessage: (threadId, text) =>
      Effect.gen(function* () {
        const thread = yield* findThread(threadId);
        if (Option.isNone(thread)) {
          return yield* new ThreadBridgeError({ message: `Thread ${threadId} was not found.` });
        }
        yield* starter
          .startTurn({
            thread: thread.value,
            messageId: MessageId.make(yield* uuid),
            text,
            attachments: [],
          })
          .pipe(Effect.catchCause(bridgeError("Could not send the message")));
      }),

    setParent: (threadId, parentThreadId) =>
      Effect.gen(function* () {
        const thread = yield* findThread(threadId);
        if (Option.isNone(thread) || (thread.value.parentThreadId ?? null) === parentThreadId)
          return;
        yield* dispatch({
          type: "thread.parent.set",
          commandId: yield* commandId("parent-set"),
          threadId,
          parentThreadId,
        });
      }),

    interruptThread: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* findThread(threadId);
        if (Option.isNone(thread) || resolveChildThreadState(thread.value) !== "working") {
          return false;
        }
        yield* dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId("interrupt"),
          threadId,
          createdAt: yield* nowIso,
        });
        return true;
      }),

    threadActivity: (threadId) =>
      snapshots.getThreadDetailById(threadId).pipe(
        Effect.catchCause(bridgeError("Could not read the thread")),
        Effect.map((detail) => {
          if (Option.isNone(detail)) return null;
          const messages = detail.value.messages;
          return {
            turns: messages.filter((message) => message.role === "user").length,
            firstAt: messages[0]?.createdAt ?? null,
            lastAt: messages.at(-1)?.createdAt ?? null,
          };
        }),
      ),

    providerUsage: () =>
      providerRegistry.getProviders.pipe(
        Effect.map((providers) =>
          providers.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            usageLimits: provider.usageLimits ?? null,
          })),
        ),
      ),
  };
  return bridge;
});
