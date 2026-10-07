/**
 * Fork: notes and todos the user keeps beside their work, in the Notes tab of
 * the right panel. Each entry belongs to a thread, a project, or the whole
 * environment (global). The server stores them so every client of the
 * environment sees the same list.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FORK_NOTES_WS_METHODS = {
  subscribe: "forkNotes.subscribe",
  act: "forkNotes.act",
} as const;

export const FORK_NOTE_MAX_TEXT_LENGTH = 20_000;

export const ForkNoteScope = Schema.Literals(["thread", "project", "global"]);
export type ForkNoteScope = typeof ForkNoteScope.Type;

/** A thread id, a project id, or "" for global. */
export const ForkNotesTarget = Schema.Struct({
  scope: ForkNoteScope,
  scopeId: Schema.String,
});
export type ForkNotesTarget = typeof ForkNotesTarget.Type;

const NoteText = TrimmedNonEmptyString.check(Schema.isMaxLength(FORK_NOTE_MAX_TEXT_LENGTH));

export const ForkNote = Schema.Struct({
  id: TrimmedNonEmptyString,
  scope: ForkNoteScope,
  scopeId: Schema.String,
  text: Schema.String,
  /** A todo has a checkbox; a note does not and is never done. */
  todo: Schema.Boolean,
  done: Schema.Boolean,
  /** Order within its scope, 0 first. */
  position: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ForkNote = typeof ForkNote.Type;

/** Every entry of one scope, in order; each change sends the full list again. */
export const ForkNotesSnapshot = Schema.Struct({
  notes: Schema.Array(ForkNote),
});
export type ForkNotesSnapshot = typeof ForkNotesSnapshot.Type;

export const ForkNotesAction = Schema.Union([
  /**
   * Adds an entry, at the top unless a position is given. The client may pick
   * the id, so undoing a delete brings the same entry back where it was.
   */
  Schema.Struct({
    type: Schema.Literal("create"),
    scope: ForkNoteScope,
    scopeId: Schema.String,
    text: NoteText,
    todo: Schema.Boolean,
    done: Schema.optional(Schema.Boolean),
    id: Schema.optional(TrimmedNonEmptyString),
    position: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    id: TrimmedNonEmptyString,
    text: Schema.optional(NoteText),
    todo: Schema.optional(Schema.Boolean),
    done: Schema.optional(Schema.Boolean),
  }),
  /**
   * Puts the entry at `position` in the scope's list (counted without the
   * entry itself), in the same scope to reorder it or in another to move it.
   * `done` checks a todo off or reopens it in the same step.
   */
  Schema.Struct({
    type: Schema.Literal("move"),
    id: TrimmedNonEmptyString,
    scope: ForkNoteScope,
    scopeId: Schema.String,
    position: NonNegativeInt,
    done: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    id: TrimmedNonEmptyString,
  }),
]);
export type ForkNotesAction = typeof ForkNotesAction.Type;

export class ForkNotesError extends Schema.TaggedError<ForkNotesError>()("ForkNotesError", {
  message: Schema.String,
}) {}

export const WsForkNotesSubscribeRpc = Rpc.make(FORK_NOTES_WS_METHODS.subscribe, {
  payload: ForkNotesTarget,
  success: ForkNotesSnapshot,
  error: Schema.Union([ForkNotesError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsForkNotesActRpc = Rpc.make(FORK_NOTES_WS_METHODS.act, {
  payload: ForkNotesAction,
  success: Schema.Struct({}),
  error: Schema.Union([ForkNotesError, EnvironmentAuthorizationError]),
});
