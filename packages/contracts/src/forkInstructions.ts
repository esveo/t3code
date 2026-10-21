/**
 * Fork: the Instructions tab of the right panel, where the user reads and
 * edits the instruction file their agent loads (CLAUDE.md, AGENTS.md). The
 * client names what it wants (scope, provider, thread); the environment's
 * server resolves the path itself, so a client can never write a path of its
 * own choosing.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

export const FORK_INSTRUCTIONS_WS_METHODS = {
  read: "forkInstructions.read",
  write: "forkInstructions.write",
} as const;

export const FORK_INSTRUCTIONS_MAX_BYTES = 1_000_000;

/** Project means the checkout the thread works in: its worktree, else the project root. */
export const ForkInstructionsScope = Schema.Literals(["project", "global"]);
export type ForkInstructionsScope = typeof ForkInstructionsScope.Type;

export const ForkInstructionsProvider = Schema.Literals(["claude", "codex"]);
export type ForkInstructionsProvider = typeof ForkInstructionsProvider.Type;

export const ForkInstructionsTarget = Schema.Struct({
  threadId: ThreadId,
  scope: ForkInstructionsScope,
  /** Left out, the server takes the thread's own provider, Claude for any other. */
  provider: Schema.optional(ForkInstructionsProvider),
  /**
   * Absolute path of one of the snapshot's `choices`. Left out, the server
   * opens the first import of a file that only imports others, else the file.
   */
  file: Schema.optional(Schema.String),
});
export type ForkInstructionsTarget = typeof ForkInstructionsTarget.Type;

export const ForkInstructionsChoice = Schema.Struct({
  path: Schema.String,
  /** The path with the home directory written as `~`. */
  displayPath: Schema.String,
  /** `entry` is the provider's own file, `import` a file it pulls in with `@path`. */
  kind: Schema.Literals(["entry", "import"]),
  exists: Schema.Boolean,
});
export type ForkInstructionsChoice = typeof ForkInstructionsChoice.Type;

export const ForkInstructionsSnapshot = Schema.Struct({
  provider: ForkInstructionsProvider,
  path: Schema.String,
  displayPath: Schema.String,
  exists: Schema.Boolean,
  content: Schema.String,
  /** A hash of the content, null while the file does not exist. */
  version: Schema.NullOr(Schema.String),
  /** The entry file and its imports, empty unless the entry only imports other files. */
  choices: Schema.Array(ForkInstructionsChoice),
  /** Other existing files the provider reads in the same place, as short hints. */
  alsoRead: Schema.Array(Schema.String),
});
export type ForkInstructionsSnapshot = typeof ForkInstructionsSnapshot.Type;

export const ForkInstructionsWriteInput = Schema.Struct({
  ...ForkInstructionsTarget.fields,
  /** The file the content belongs to, as the snapshot it was edited from named it. */
  file: Schema.String,
  content: Schema.String.check(Schema.isMaxLength(FORK_INSTRUCTIONS_MAX_BYTES)),
  /** The snapshot's version; a file changed since is not overwritten unless `force`. */
  expectedVersion: Schema.NullOr(Schema.String),
  force: Schema.optional(Schema.Boolean),
});
export type ForkInstructionsWriteInput = typeof ForkInstructionsWriteInput.Type;

export class ForkInstructionsError extends Schema.TaggedError<ForkInstructionsError>()(
  "ForkInstructionsError",
  { message: Schema.String },
) {}

/** The file changed on disk since the client read it. */
export class ForkInstructionsConflictError extends Schema.TaggedError<ForkInstructionsConflictError>()(
  "ForkInstructionsConflictError",
  { message: Schema.String },
) {}

export const WsForkInstructionsReadRpc = Rpc.make(FORK_INSTRUCTIONS_WS_METHODS.read, {
  payload: ForkInstructionsTarget,
  success: ForkInstructionsSnapshot,
  error: Schema.Union([ForkInstructionsError, EnvironmentAuthorizationError]),
});

export const WsForkInstructionsWriteRpc = Rpc.make(FORK_INSTRUCTIONS_WS_METHODS.write, {
  payload: ForkInstructionsWriteInput,
  success: ForkInstructionsSnapshot,
  error: Schema.Union([
    ForkInstructionsError,
    ForkInstructionsConflictError,
    EnvironmentAuthorizationError,
  ]),
});
