/**
 * The thinking a turn produced, compacted for reading.
 *
 * The trail is what the reader gets instead of scrolling a thousand lines of
 * trace: a handful of beats in order, and where it came out. The server builds
 * it from the stored reasoning; the client only decides who gets to ask.
 */
export interface ThoughtTrail {
  readonly steps: ReadonlyArray<string>;
  readonly outcome: string | null;
}

/** A timeline entry, narrowed to the part that says whether a turn thought. */
export interface ThoughtEntry {
  readonly kind: string;
  readonly message?:
    | {
        readonly role: string;
        readonly text: string;
        readonly turnId: string | null;
      }
    | undefined;
}

/**
 * Turns whose thinking is finished and worth recapping.
 *
 * Deliberately no text: this runs on every streaming frame, so it counts what
 * is there and leaves the reading to the server. The live turn is left out,
 * because a recap of a trace that is still growing is stale the moment it is
 * read.
 */
export function deriveTurnsWithThoughts(
  entries: ReadonlyArray<ThoughtEntry>,
  skipTurnId: string | null,
): ReadonlySet<string> {
  const turns = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    if (
      message?.role === "reasoning" &&
      message.turnId !== null &&
      message.turnId !== skipTurnId &&
      message.text.trim().length > 0
    ) {
      turns.add(message.turnId);
    }
  }
  return turns;
}
