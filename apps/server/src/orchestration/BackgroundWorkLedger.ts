/**
 * BackgroundWorkLedger - keeps a thread's running background work (subagents,
 * workflows, watch loops) in its provider session binding, so a restart can
 * name exactly what it killed and the continuation can resume it.
 *
 * ThreadBackgroundLivenessService only lives in memory. This layer folds the
 * same task lifecycle with the same rules and writes the thread's live task
 * list whenever it changes; progress ticks never write. Startup reconciliation
 * reads the list back (see reconcileProviderSessions).
 *
 * The layer is built on top of ProviderService, so it is torn down before
 * ProviderService stops every session on shutdown: those session.exited
 * events never reach it and the list survives the restart it exists for.
 *
 * @module BackgroundWorkLedger
 */
import { MONITOR_TASK_TYPES, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

export const BACKGROUND_TASKS_KEY = "liveBackgroundTasks";

export interface BackgroundTask {
  readonly taskId: string;
  readonly kind: "agent" | "workflow" | "monitor";
  readonly taskType?: string;
  readonly title?: string;
  readonly role?: string;
  readonly runId?: string;
}

interface TaskInfo extends BackgroundTask {
  readonly parentAgentId?: string;
}

type TaskEvent = Extract<
  ProviderRuntimeEvent,
  { type: "task.started" | "task.progress" | "task.updated" | "task.completed" }
>;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

function classify(taskType: string | undefined, runId: string | undefined): BackgroundTask["kind"] {
  if (taskType !== undefined && MONITOR_TASK_TYPES.has(taskType)) return "monitor";
  if (taskType === "local_workflow" || runId !== undefined) return "workflow";
  return "agent";
}

/**
 * Pure fold over task lifecycle events. `record` returns the thread's new live
 * task list when it changed, and undefined otherwise.
 */
export function makeBackgroundTaskTracker() {
  const liveness = ThreadBackgroundLiveness.make();
  const infoByThread = new Map<string, Map<string, TaskInfo>>();
  const lastByThread = new Map<string, string>();

  const snapshot = (threadId: string): ReadonlyArray<BackgroundTask> | undefined => {
    const liveIds = new Set(liveness.getLiveTaskIds(threadId));
    const infos = infoByThread.get(threadId) ?? new Map<string, TaskInfo>();
    for (const taskId of infos.keys()) {
      if (!liveIds.has(taskId)) infos.delete(taskId);
    }
    if (infos.size === 0) infoByThread.delete(threadId);
    // Workflow members resume with their workflow; list only the top level.
    const tasks = [...infos.values()]
      .filter((info) => info.parentAgentId === undefined || !liveIds.has(info.parentAgentId))
      .map(({ parentAgentId: _parent, ...task }) => task);
    const serialized = JSON.stringify(tasks);
    if (serialized === (lastByThread.get(threadId) ?? "[]")) return undefined;
    if (tasks.length === 0) lastByThread.delete(threadId);
    else lastByThread.set(threadId, serialized);
    return tasks;
  };

  return {
    record: (event: TaskEvent): ReadonlyArray<BackgroundTask> | undefined => {
      const threadId = event.threadId;
      const payload = event.payload as Record<string, unknown>;
      const taskId = String(payload.taskId);
      const taskType = nonEmpty(payload.taskType);
      liveness.recordTaskLiveness({
        threadId,
        taskId,
        taskType,
        status: nonEmpty(payload.status),
        agentId: nonEmpty(payload.agentId),
        kind:
          event.type === "task.started"
            ? "started"
            : event.type === "task.progress"
              ? "progress"
              : event.type === "task.updated"
                ? "updated"
                : "completed",
      });
      if (liveness.getLiveTaskIds(threadId).includes(taskId)) {
        const infos = infoByThread.get(threadId) ?? new Map<string, TaskInfo>();
        infoByThread.set(threadId, infos);
        const existing = infos.get(taskId);
        const runHandles = payload.runHandles as { runId?: unknown } | undefined;
        const resolvedType = taskType ?? existing?.taskType;
        const runId = nonEmpty(runHandles?.runId) ?? existing?.runId;
        // task.progress descriptions narrate the current step, not the task.
        const title =
          existing?.title ??
          nonEmpty(payload.title) ??
          (event.type === "task.started" ? nonEmpty(payload.description) : undefined);
        const role = nonEmpty(payload.role) ?? existing?.role;
        const parentAgentId = nonEmpty(payload.parentAgentId) ?? existing?.parentAgentId;
        infos.set(taskId, {
          taskId,
          kind: classify(resolvedType, runId),
          ...(resolvedType ? { taskType: resolvedType } : {}),
          ...(title ? { title } : {}),
          ...(role ? { role } : {}),
          ...(runId ? { runId } : {}),
          ...(parentAgentId ? { parentAgentId } : {}),
        });
      }
      return snapshot(threadId);
    },

    /** The session ended while the server kept running: its work is gone. */
    clear: (threadId: string): ReadonlyArray<BackgroundTask> | undefined => {
      liveness.clearThreadLiveness(threadId);
      infoByThread.delete(threadId);
      return snapshot(threadId);
    },
  };
}

export function readBackgroundTasks(runtimePayload: unknown): ReadonlyArray<BackgroundTask> {
  if (runtimePayload === null || typeof runtimePayload !== "object") return [];
  const value = (runtimePayload as Record<string, unknown>)[BACKGROUND_TASKS_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (task): task is BackgroundTask =>
      task !== null &&
      typeof task === "object" &&
      typeof task.taskId === "string" &&
      (task.kind === "agent" || task.kind === "workflow" || task.kind === "monitor"),
  );
}

function describeTask(task: BackgroundTask): string {
  const name = task.title ? `"${task.title}"` : task.taskId;
  switch (task.kind) {
    case "workflow":
      return task.runId
        ? `- Workflow ${name} (run ${task.runId}): resume it with the Workflow tool and resumeFromRunId "${task.runId}". Finished agents return their cached results; only unfinished ones run again.`
        : `- Workflow ${name}: start it again if it is still needed.`;
    case "monitor":
      return `- Background command or monitor ${name}: start it again if it is still needed.`;
    case "agent": {
      const role = task.role ? ` (${task.role})` : "";
      return task.taskType === "local_agent"
        ? `- Subagent ${name}${role}, id ${task.taskId}: resume it with SendMessage to "${task.taskId}". It keeps its context; tell it that it was interrupted by a restart and should continue where it left off.`
        : `- Agent ${name}${role}, id ${task.taskId}: continue it if your tools allow, otherwise start it again if it is still needed.`;
    }
  }
}

export function buildBackgroundWorkContinuationPrompt(
  tasks: ReadonlyArray<BackgroundTask>,
): string {
  return [
    "Continue where you left off. A server restart stopped this session, including background work that was still running:",
    ...tasks.map(describeTask),
    "Resume each of these unless it is no longer needed, and do not redo work that already finished.",
  ].join("\n");
}

export const BackgroundWorkLedgerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const tracker = makeBackgroundTaskTracker();

    const persist = (
      threadId: ProviderRuntimeEvent["threadId"],
      tasks: ReadonlyArray<BackgroundTask>,
    ) =>
      directory.getBinding(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) =>
              directory.upsert({
                threadId,
                provider: binding.provider,
                runtimePayload: { [BACKGROUND_TASKS_KEY]: tasks.length > 0 ? tasks : null },
              }),
          }),
        ),
      );

    yield* providerService.streamEvents.pipe(
      Stream.runForEach((event) => {
        const changed =
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.updated" ||
          event.type === "task.completed"
            ? tracker.record(event)
            : event.type === "session.exited"
              ? tracker.clear(event.threadId)
              : undefined;
        return changed === undefined
          ? Effect.void
          : // One failed write must not end the subscriber for every later event.
            persist(event.threadId, changed).pipe(Effect.ignoreCause({ log: true }));
      }),
      Effect.forkScoped,
    );
  }),
);
