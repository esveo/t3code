/**
 * The narrow interface through which the initiatives module reaches threads.
 * The module never talks to the orchestration engine itself: V1 has one
 * adapter (apps/server/src/initiatives/ThreadBridgeV1.ts), Orchestration V2
 * gets a second one, and nothing else changes.
 */
import type {
  InitiativeLaunchJob,
  ModelSelection,
  OrchestrationThreadShell,
  ProjectId,
  RuntimeMode,
  ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ThreadBridgeCapabilities {
  readonly runtimeModes: ReadonlyArray<RuntimeMode>;
  /** V1 threads have one level of parents; V2 brings real lineage. */
  readonly lineage: "one-level" | "tree";
}

export interface ThreadBridgeProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ThreadBridgeStart {
  readonly threadId: ThreadId;
  readonly branch: string | null;
  readonly worktree: boolean;
}

export class ThreadBridgeError extends Schema.TaggedError<ThreadBridgeError>()(
  "ThreadBridgeError",
  {
    message: Schema.String,
  },
) {}

export interface ThreadBridge {
  readonly capabilities: ThreadBridgeCapabilities;
  /**
   * Starts the job's thread under the job's `threadId`, in the job's mode.
   * The adapter refuses a thread id that exists, so a second call for the
   * same job cannot start a second thread.
   */
  readonly startThread: (
    job: InitiativeLaunchJob,
    prompt: string,
  ) => Effect.Effect<ThreadBridgeStart, ThreadBridgeError>;
  /** The job's thread, for the check after a restart. */
  readonly findThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ThreadBridgeError>;
  readonly listThreads: () => Effect.Effect<
    ReadonlyArray<OrchestrationThreadShell>,
    ThreadBridgeError
  >;
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ThreadBridgeProject>, ThreadBridgeError>;
  /** The project at this folder, created when there is none (work without code). */
  readonly ensureProject: (input: {
    readonly workspaceRoot: string;
    readonly title: string;
  }) => Effect.Effect<ThreadBridgeProject, ThreadBridgeError>;
  /** Keeps the coordinator on top of the user's sidebar. */
  readonly setPinned: (
    threadId: ThreadId,
    pinned: boolean,
  ) => Effect.Effect<void, ThreadBridgeError>;
  /** How many turns a thread had and when it began and last spoke, for its statistics. */
  readonly threadActivity: (threadId: ThreadId) => Effect.Effect<
    {
      readonly turns: number;
      readonly firstAt: string | null;
      readonly lastAt: string | null;
    } | null,
    ThreadBridgeError
  >;
  /** Every provider instance with its quota windows as it last reported them. */
  readonly providerUsage: () => Effect.Effect<
    ReadonlyArray<{
      readonly instanceId: string;
      readonly driver: string;
      readonly usageLimits: ServerProviderUsageLimits | null;
    }>
  >;
  /** Stops the thread's running turn; false when it was not working. */
  readonly interruptThread: (threadId: ThreadId) => Effect.Effect<boolean, ThreadBridgeError>;
  /** Hands a thread to another coordinator, whose updates it then reports to. */
  readonly setParent: (
    threadId: ThreadId,
    parentThreadId: ThreadId | null,
  ) => Effect.Effect<void, ThreadBridgeError>;
  /**
   * The model a new thread runs on: the named provider and model, checked
   * against the usable ones, or else the parent's, the project's default or
   * the first usable provider's. With its driver, to pick the runtime mode.
   */
  readonly resolveModel: (input: {
    readonly projectId: ProjectId;
    readonly parentThreadId: ThreadId | null;
    readonly provider: string | null;
    readonly model: string | null;
  }) => Effect.Effect<
    { readonly modelSelection: ModelSelection; readonly driver: string | null },
    ThreadBridgeError
  >;
}
