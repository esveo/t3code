import type { TerminalSummary, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminals = yield* TerminalManager.TerminalManager;

  const threadShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.mapError((cause) => new TerminalLookupFailedError({ cause })),
      Effect.flatMap((thread) =>
        Effect.fromOption(thread).pipe(
          Effect.mapError(() => new TerminalThreadNotFoundError({ threadId })),
        ),
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
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (requested === undefined || requested === scope.threadId) return scope.threadId;
    const [caller, target] = yield* Effect.all([
      threadShell(scope.threadId),
      threadShell(requested),
    ]);
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

  return TerminalsToolkit.of({
    list_terminals: (input) =>
      Effect.gen(function* () {
        const threadId = yield* resolveThreadId(input.threadId);
        const loaded = yield* loadedTerminals(threadId);
        return { threadId, terminals: loaded.map(entryOf) };
      }),
    read_terminal: (input) =>
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
  });
});

export const TerminalsToolkitHandlersLive = TerminalsToolkit.toLayer(make);
