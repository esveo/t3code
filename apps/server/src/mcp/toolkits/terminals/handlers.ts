import type { TerminalSummary, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { terminalTail } from "./terminalText.ts";
import {
  READ_TERMINAL_DEFAULT_LINES,
  READ_TERMINAL_MAX_CHARS,
  TerminalLookupFailedError,
  TerminalNotLoadedError,
  TerminalsToolkit,
  TerminalThreadNotFoundError,
  TerminalThreadOutsideProjectError,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const terminals = yield* TerminalManager.TerminalManager;

  const threadShell = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.mapError((cause) => new TerminalLookupFailedError({ cause })),
      Effect.flatMap((thread) =>
        thread === null
          ? Effect.fail(new TerminalThreadNotFoundError({ threadId }))
          : Effect.succeed(thread),
      ),
    );

  /**
   * The thread whose terminals the call reads: the caller's own, or another
   * thread of the caller's project. Terminal output can carry secrets, so a
   * credential never reaches past its project.
   */
  const resolveThreadId = Effect.fn("TerminalsToolkit.resolveThreadId")(function* (
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
      Effect.flatMap((invocation) =>
        McpInvocationContext.requireThreadScope(invocation, "Terminal tools"),
      ),
    );
    const callerId = scope.thread.threadId;
    if (requested === undefined || requested === callerId) return callerId;
    const [caller, target] = yield* Effect.all([threadShell(callerId), threadShell(requested)]);
    if (caller.projectId !== target.projectId) {
      return yield* new TerminalThreadOutsideProjectError({ threadId: requested });
    }
    return requested;
  });

  // Most recent output first, so the default terminal is the one that just printed.
  const loadedTerminals = (threadId: ThreadId) =>
    (terminals.inspectLoadedThread?.(threadId) ?? Effect.succeed([])).pipe(
      Effect.map((loaded) =>
        loaded.toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.terminalId.localeCompare(right.terminalId),
        ),
      ),
    );

  const entryOf = (terminal: TerminalSummary) => ({
    terminalId: terminal.terminalId,
    label: terminal.label,
    cwd: terminal.cwd,
    status: terminal.status,
    hasRunningSubprocess: terminal.hasRunningSubprocess,
    exitCode: terminal.exitCode,
    updatedAt: terminal.updatedAt,
  });

  // Fork: terminals belong to the calling thread's project, so only thread callers read them.
  return {
    list_terminals: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* resolveThreadId(input.threadId);
        const loaded = yield* loadedTerminals(threadId);
        return { threadId, terminals: loaded.map(entryOf) };
      }),
    ),
    read_terminal: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* resolveThreadId(input.threadId);
        const loaded = yield* loadedTerminals(threadId);
        const terminal =
          input.terminalId === undefined
            ? loaded[0]
            : loaded.find((candidate) => candidate.terminalId === input.terminalId);
        if (terminal === undefined) {
          return yield* new TerminalNotLoadedError({
            threadId,
            terminalId: input.terminalId ?? null,
          });
        }
        const tail = terminalTail(
          terminal.history(),
          input.lines ?? READ_TERMINAL_DEFAULT_LINES,
          READ_TERMINAL_MAX_CHARS,
        );
        return {
          ...entryOf(terminal),
          threadId,
          output: tail.text,
          omittedLines: tail.omittedLines,
          truncated: tail.truncated,
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof TerminalsToolkit.tools>;
});

export const TerminalsToolkitHandlersLive = McpToolAccess.toLayer(TerminalsToolkit, make);
