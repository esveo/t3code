import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type TerminalSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TerminalsToolkitHandlersLive } from "./handlers.ts";
import { TerminalsToolkit } from "./tools.ts";

const CALLER = ThreadId.make("thread-caller");
const SIBLING = ThreadId.make("thread-sibling");
const STRANGER = ThreadId.make("thread-stranger");

const shell = (id: ThreadId, projectId: string) =>
  ({ id, projectId: ProjectId.make(projectId) }) as OrchestrationV2ThreadShell;
const threads = new Map([
  [CALLER, shell(CALLER, "project-1")],
  [SIBLING, shell(SIBLING, "project-1")],
  [STRANGER, shell(STRANGER, "project-2")],
]);

const terminal = (
  threadId: ThreadId,
  terminalId: string,
  updatedAt: string,
  history: string,
): TerminalSummary & { readonly history: () => string } => ({
  threadId,
  terminalId,
  cwd: "/workspace/project",
  worktreePath: null,
  status: "running",
  pid: 42,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: terminalId,
  updatedAt,
  history: () => history,
});

const loaded = [
  terminal(CALLER, "term-1", "2026-09-28T10:00:00.000Z", "old shell\r\n"),
  terminal(CALLER, "term-2", "2026-09-28T11:00:00.000Z", "\u001b[31merror\u001b[0m: boom\r\n"),
  terminal(SIBLING, "term-1", "2026-09-28T09:00:00.000Z", "sibling output\r\n"),
  terminal(STRANGER, "term-1", "2026-09-28T09:00:00.000Z", "secret\r\n"),
];

const dependencies = Layer.mergeAll(
  Layer.mock(OrchestratorV2)({
    getThreadShell: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
  }),
  Layer.mock(TerminalManager)({
    inspectLoadedThread: (threadId) =>
      Effect.succeed(loaded.filter((candidate) => candidate.threadId === threadId)),
  }),
);

const call = <Name extends keyof typeof TerminalsToolkit.tools>(
  name: Name,
  params: Tool.Parameters<(typeof TerminalsToolkit.tools)[Name]>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* TerminalsToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(TerminalsToolkitHandlersLive).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    return yield* toolkit.handle(name, params as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof TerminalsToolkit.tools)[Name]>,
      ),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "provider-session-1",
      thread: {
        threadId: CALLER,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claude"),
      },
      client: undefined,
      capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests"]),
      issuedAt: 1,
    }),
    Effect.provide(dependencies),
  );

describe("terminal toolkit handlers", () => {
  it.effect("lists the caller's terminals, most recent output first", () =>
    Effect.gen(function* () {
      const result = yield* call("list_terminals", {});
      expect(result.threadId).toBe(CALLER);
      expect(result.terminals.map((entry) => entry.terminalId)).toEqual(["term-2", "term-1"]);
    }),
  );

  it.effect("reads the most recent terminal as plain text by default", () =>
    Effect.gen(function* () {
      const result = yield* call("read_terminal", {});
      expect(result).toMatchObject({ terminalId: "term-2", output: "error: boom" });
    }),
  );

  it.effect("reads another thread of the same project", () =>
    Effect.gen(function* () {
      const result = yield* call("read_terminal", { threadId: SIBLING, terminalId: "term-1" });
      expect(result.output).toBe("sibling output");
    }),
  );

  it.effect("refuses a thread of another project", () =>
    Effect.gen(function* () {
      const error = yield* call("read_terminal", { threadId: STRANGER }).pipe(Effect.flip);
      expect(error._tag).toBe("TerminalThreadOutsideProjectError");
    }),
  );

  it.effect("reports a terminal that is not open", () =>
    Effect.gen(function* () {
      const error = yield* call("read_terminal", { terminalId: "term-9" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "TerminalNotLoadedError", terminalId: "term-9" });
    }),
  );
});
