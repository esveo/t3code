/**
 * Fork: read-only access to the terminals in a thread's terminal drawer. The
 * tools read what the TerminalManager already holds in memory; they never
 * open, attach to, write to, restart or close a terminal.
 */
import { TerminalSessionStatus, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestratorV2,
  TerminalManager.TerminalManager,
];

export const READ_TERMINAL_DEFAULT_LINES = 200;
export const READ_TERMINAL_MAX_LINES = 1_000;
/** Keeps a result well below the ~100 KB at which Claude Code drops tool output. */
export const READ_TERMINAL_MAX_CHARS = 40_000;

const ThreadIdInput = Schema.optional(
  ThreadId.annotate({
    description:
      "Thread whose terminals to read. Defaults to this thread; another thread must belong to the same project.",
  }),
);

export const ListTerminalsInput = Schema.Struct({ threadId: ThreadIdInput });

export const ReadTerminalInput = Schema.Struct({
  threadId: ThreadIdInput,
  terminalId: Schema.optional(
    Schema.String.annotate({
      description:
        "Terminal to read, as returned by list_terminals. Defaults to the terminal with the most recent output.",
    }),
  ),
  lines: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: READ_TERMINAL_MAX_LINES })).annotate({
      description: `How many of the last lines to return. Defaults to ${READ_TERMINAL_DEFAULT_LINES}, at most ${READ_TERMINAL_MAX_LINES}.`,
    }),
  ),
});
export type ReadTerminalInput = typeof ReadTerminalInput.Type;

export class TerminalThreadNotFoundError extends Schema.TaggedError<TerminalThreadNotFoundError>()(
  "TerminalThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class TerminalThreadOutsideProjectError extends Schema.TaggedError<TerminalThreadOutsideProjectError>()(
  "TerminalThreadOutsideProjectError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} belongs to another project; only terminals of this project's threads can be read.`;
  }
}

export class TerminalNotLoadedError extends Schema.TaggedError<TerminalNotLoadedError>()(
  "TerminalNotLoadedError",
  { threadId: Schema.String, terminalId: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.terminalId === null
      ? `Thread ${this.threadId} has no open terminal.`
      : `Terminal ${this.terminalId} is not open in thread ${this.threadId}. Call list_terminals for the open ones.`;
  }
}

export class TerminalLookupFailedError extends Schema.TaggedError<TerminalLookupFailedError>()(
  "TerminalLookupFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not look up the thread.";
  }
}

export const TerminalToolError = Schema.Union([
  TerminalThreadNotFoundError,
  TerminalThreadOutsideProjectError,
  TerminalNotLoadedError,
  TerminalLookupFailedError,
]);

const TerminalEntry = Schema.Struct({
  terminalId: Schema.String,
  label: Schema.String.annotate({
    description: "Title shown in the drawer: the running command, or the terminal's name.",
  }),
  cwd: Schema.String,
  status: TerminalSessionStatus,
  hasRunningSubprocess: Schema.Boolean.annotate({
    description: "True while a command runs in the shell, for example a dev server.",
  }),
  exitCode: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});

export const ListTerminalsResult = Schema.Struct({
  threadId: Schema.String,
  terminals: Schema.Array(TerminalEntry),
});

export const ReadTerminalResult = Schema.Struct({
  ...TerminalEntry.fields,
  threadId: Schema.String,
  output: Schema.String.annotate({
    description: "The last lines of output as plain text, with colors and cursor control removed.",
  }),
  omittedLines: Schema.Int.annotate({
    description: "Older retained lines left out; ask for more lines to see them.",
  }),
  truncated: Schema.Boolean.annotate({
    description: `True when the lines were cut further to stay under ${READ_TERMINAL_MAX_CHARS} characters.`,
  }),
});
export type ReadTerminalResult = typeof ReadTerminalResult.Type;

const ListTerminalsTool = Tool.make("list_terminals", {
  description:
    "List the terminals open in a thread's terminal drawer, with their title, working directory and whether a command is running. Read-only.",
  parameters: ListTerminalsInput,
  success: ListTerminalsResult,
  failure: TerminalToolError,
  dependencies,
})
  .annotate(Tool.Title, "List terminals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadTerminalTool = Tool.make("read_terminal", {
  description:
    "Read the recent output of a terminal in a thread's terminal drawer as plain text, for example a dev server's log or a failed command. Only reads what the terminal still holds; it cannot type into, start, restart or close a terminal.",
  parameters: ReadTerminalInput,
  success: ReadTerminalResult,
  failure: TerminalToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read terminal output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalsToolkit = Toolkit.make(ListTerminalsTool, ReadTerminalTool);
