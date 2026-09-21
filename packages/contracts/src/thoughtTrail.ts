import * as Schema from "effect/Schema";

import { ThreadId, TurnId } from "./baseSchemas.ts";

/**
 * A turn's thinking, compacted for reading.
 *
 * Asked for per turn rather than produced with it: the trace is cheap to keep
 * and expensive to summarize, so the recap is made when somebody wants it.
 */
export const ThoughtTrailInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type ThoughtTrailInput = typeof ThoughtTrailInput.Type;

export const ThoughtTrailResult = Schema.Struct({
  /** Beats in the order they happened. Empty when the model found none. */
  steps: Schema.Array(Schema.String),
  /** Where the thinking landed, when it is worth stating separately. */
  outcome: Schema.NullOr(Schema.String),
  /** What produced the recap, for the reader deciding how much to trust it. */
  model: Schema.String,
});
export type ThoughtTrailResult = typeof ThoughtTrailResult.Type;

export class ThoughtTrailError extends Schema.TaggedError<ThoughtTrailError>()(
  "ThoughtTrailError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
