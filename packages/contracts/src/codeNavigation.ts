/**
 * Fork: VS Code-style code navigation in the diff viewers. Search based, like
 * GitHub's: the server parses files at the requested revision with tree-sitter
 * and finds candidates with `git grep`, so it works at any commit without a
 * language server.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CODE_NAVIGATION_WS_METHODS = {
  resolveDefinition: "codeNavigation.resolveDefinition",
  findReferences: "codeNavigation.findReferences",
  readFile: "codeNavigation.readFile",
} as const;

/**
 * Which version of the repository a position refers to. `git` takes any
 * revision git understands (a sha, `HEAD`, a branch); `mergeBase` is the merge
 * base of `ref` and `HEAD`, the old side of the branch diff; `checkpoint` is
 * the snapshot after turn `turnCount` of a thread (0 is the thread's start).
 * `pullRequest` is one side of a pull request's diff as the host computes it:
 * `head` is the head commit (or `commit`), `base` its merge base with
 * `baseBranch` (or `commit`'s parent). Commits the clone lacks are fetched from
 * the remote that hosts `repository` (`owner/name`).
 */
export const CodeNavigationRevision = Schema.Union([
  Schema.TaggedStruct("workingTree", {}),
  Schema.TaggedStruct("git", { ref: TrimmedNonEmptyString }),
  Schema.TaggedStruct("mergeBase", { ref: TrimmedNonEmptyString }),
  Schema.TaggedStruct("checkpoint", { threadId: ThreadId, turnCount: NonNegativeInt }),
  Schema.TaggedStruct("pullRequest", {
    side: Schema.Literals(["base", "head"]),
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
    baseBranch: TrimmedNonEmptyString,
    /** The head commit as the host reports it; asked of the remote when absent. */
    headSha: Schema.optional(TrimmedNonEmptyString),
    /** The pull request's oldest commit: its parent is the base once the head is merged. */
    firstCommit: Schema.optional(TrimmedNonEmptyString),
    /** One commit of the change instead of all of it. */
    commit: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type CodeNavigationRevision = typeof CodeNavigationRevision.Type;

export const CodeNavigationPositionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  revision: CodeNavigationRevision,
  /** Relative to the repository root, as diffs show it. */
  path: TrimmedNonEmptyString,
  /** 1-based. */
  line: PositiveInt,
  /** 0-based, in UTF-16 code units. */
  column: NonNegativeInt,
  /**
   * The file's text as the client shows it, used instead of the file at the
   * revision: an editor's unsaved buffer, so positions match what the user sees.
   */
  content: Schema.optional(Schema.String),
});
export type CodeNavigationPositionInput = typeof CodeNavigationPositionInput.Type;

/** An identifier in a file: its line (1-based) and column range (0-based, end exclusive). */
export const CodeNavigationSymbol = Schema.Struct({
  name: Schema.String,
  line: PositiveInt,
  column: NonNegativeInt,
  endColumn: NonNegativeInt,
});
export type CodeNavigationSymbol = typeof CodeNavigationSymbol.Type;

export const CodeNavigationLocation = Schema.Struct({
  path: Schema.String,
  line: PositiveInt,
  column: NonNegativeInt,
  endColumn: NonNegativeInt,
  /** The trimmed source line, for result lists. */
  preview: Schema.String,
  /** `function`, `class`, `variable`, …; `reference` for a plain use. */
  kind: Schema.String,
});
export type CodeNavigationLocation = typeof CodeNavigationLocation.Type;

export const CodeNavigationDefinitionResult = Schema.Struct({
  /** The identifier at the position; null on keywords, strings, comments and unsupported files. */
  symbol: Schema.NullOr(CodeNavigationSymbol),
  /** The identifier is itself a definition; clicking it shows its references. */
  isDefinition: Schema.Boolean,
  definitions: Schema.Array(CodeNavigationLocation),
});
export type CodeNavigationDefinitionResult = typeof CodeNavigationDefinitionResult.Type;

export const CodeNavigationReferencesResult = Schema.Struct({
  symbol: Schema.NullOr(CodeNavigationSymbol),
  references: Schema.Array(CodeNavigationLocation),
  /** More matches existed than were returned. */
  truncated: Schema.Boolean,
});
export type CodeNavigationReferencesResult = typeof CodeNavigationReferencesResult.Type;

export const CodeNavigationReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  revision: CodeNavigationRevision,
  path: TrimmedNonEmptyString,
});
export type CodeNavigationReadFileInput = typeof CodeNavigationReadFileInput.Type;

export const CodeNavigationReadFileResult = Schema.Struct({
  path: Schema.String,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type CodeNavigationReadFileResult = typeof CodeNavigationReadFileResult.Type;

export class CodeNavigationError extends Schema.TaggedError<CodeNavigationError>()(
  "CodeNavigationError",
  { message: Schema.String },
) {}

export const WsCodeNavigationResolveDefinitionRpc = Rpc.make(
  CODE_NAVIGATION_WS_METHODS.resolveDefinition,
  {
    payload: CodeNavigationPositionInput,
    success: CodeNavigationDefinitionResult,
    error: Schema.Union([CodeNavigationError, EnvironmentAuthorizationError]),
  },
);

export const WsCodeNavigationFindReferencesRpc = Rpc.make(
  CODE_NAVIGATION_WS_METHODS.findReferences,
  {
    payload: CodeNavigationPositionInput,
    success: CodeNavigationReferencesResult,
    error: Schema.Union([CodeNavigationError, EnvironmentAuthorizationError]),
  },
);

export const WsCodeNavigationReadFileRpc = Rpc.make(CODE_NAVIGATION_WS_METHODS.readFile, {
  payload: CodeNavigationReadFileInput,
  success: CodeNavigationReadFileResult,
  error: Schema.Union([CodeNavigationError, EnvironmentAuthorizationError]),
});
