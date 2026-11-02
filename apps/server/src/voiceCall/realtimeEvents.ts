/**
 * Fork: the realtime v3 ("GPT-Live") events the voice call reads and sends.
 * The protocol is undocumented; everything here comes from Codex's own client
 * and the 2026-10-22 spike (docs/internals/voice-call.md, "Protocol").
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type RealtimeSpeaker = "user" | "voice";

export type RealtimeEvent =
  | { readonly type: "session.started"; readonly sessionId: string; readonly expiresAt: number }
  | { readonly type: "transcript"; readonly speaker: RealtimeSpeaker; readonly text: string }
  | {
      readonly type: "turn.created";
      readonly turnId: string;
      readonly speaker: RealtimeSpeaker;
      readonly text: string;
    }
  | {
      readonly type: "turn.delta";
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: "turn.done";
      readonly turnId: string;
      readonly speaker: RealtimeSpeaker;
      readonly text: string;
    }
  | { readonly type: "delegation.created"; readonly itemId: string; readonly text: string }
  | { readonly type: "context.appended"; readonly delegationItemId: string | null }
  | {
      readonly type: "usage";
      readonly audioDurationMs: number;
      readonly limitStatus: string | null;
      readonly limitResetSeconds: number | null;
    }
  | { readonly type: "session.closed"; readonly reason: string | null }
  | { readonly type: "error"; readonly code: string; readonly message: string };

const Role = Schema.Literals(["user", "assistant"]);
const speakerOf = (role: typeof Role.Type): RealtimeSpeaker => (role === "user" ? "user" : "voice");
const Text = Schema.Struct({ text: Schema.String });
const Turn = Schema.Struct({
  id: Schema.String,
  role: Role,
  transcript: Schema.optional(Schema.String),
});

const SessionStarted = Schema.Struct({
  session: Schema.Struct({ id: Schema.String, expires_at: Schema.Number }),
});
const TranscriptAdded = Schema.Struct({ item: Text });
const TurnEvent = Schema.Struct({ turn: Turn });
const TurnDelta = Schema.Struct({ turn_id: Schema.String, delta: Schema.String });
const DelegationCreated = Schema.Struct({
  item: Schema.Struct({ id: Schema.String, content: Schema.optional(Schema.Array(Text)) }),
});
const DelegationAppended = Schema.Struct({ delegation_item_id: Schema.String });
const UsageUpdated = Schema.Struct({
  usage: Schema.Struct({ audio_duration_ms: Schema.Number }),
  usage_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        status: Schema.optional(Schema.NullOr(Schema.String)),
        reset_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
const SessionClosed = Schema.Struct({ reason: Schema.optional(Schema.NullOr(Schema.String)) });
const ErrorEvent = Schema.Struct({
  error: Schema.Struct({ code: Schema.optional(Schema.String), message: Schema.String }),
});
const Envelope = Schema.Struct({ type: Schema.String });
const decodeDelegationAppended = Schema.decodeUnknownOption(DelegationAppended);
const decodeDelegationCreated = Schema.decodeUnknownOption(DelegationCreated);
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const decodeErrorEvent = Schema.decodeUnknownOption(ErrorEvent);
const decodeSessionClosed = Schema.decodeUnknownOption(SessionClosed);
const decodeSessionStarted = Schema.decodeUnknownOption(SessionStarted);
const decodeTranscriptAdded = Schema.decodeUnknownOption(TranscriptAdded);
const decodeTurnDelta = Schema.decodeUnknownOption(TurnDelta);
const decodeTurnEvent = Schema.decodeUnknownOption(TurnEvent);
const decodeUsageUpdated = Schema.decodeUnknownOption(UsageUpdated);

/** The events the call acts on; everything else (audio frames among them) is `None`. */
export const decodeRealtimeEvent = (raw: unknown): Option.Option<RealtimeEvent> => {
  const envelope = decodeEnvelope(raw);
  if (Option.isNone(envelope)) return Option.none();
  switch (envelope.value.type) {
    case "session.started":
      return Option.map(decodeSessionStarted(raw), (event) => ({
        type: "session.started" as const,
        sessionId: event.session.id,
        expiresAt: event.session.expires_at,
      }));
    case "input_transcript.added":
    case "output_transcript.added":
      return Option.map(decodeTranscriptAdded(raw), (event) => ({
        type: "transcript" as const,
        speaker: envelope.value.type === "input_transcript.added" ? "user" : "voice",
        text: event.item.text,
      }));
    case "turn.created":
    case "turn.done":
      return Option.map(decodeTurnEvent(raw), (event) => ({
        type: envelope.value.type as "turn.created" | "turn.done",
        turnId: event.turn.id,
        speaker: speakerOf(event.turn.role),
        text: event.turn.transcript ?? "",
      }));
    case "turn.delta":
      return Option.map(decodeTurnDelta(raw), (event) => ({
        type: "turn.delta" as const,
        turnId: event.turn_id,
        text: event.delta,
      }));
    case "delegation.created":
      return Option.map(decodeDelegationCreated(raw), (event) => ({
        type: "delegation.created" as const,
        itemId: event.item.id,
        text: (event.item.content ?? []).map((part) => part.text).join(""),
      }));
    case "delegation.context.appended":
      return Option.map(decodeDelegationAppended(raw), (event) => ({
        type: "context.appended" as const,
        delegationItemId: event.delegation_item_id,
      }));
    case "session.context.appended":
      return Option.some({ type: "context.appended", delegationItemId: null });
    case "session.usage.updated":
      return Option.map(decodeUsageUpdated(raw), (event) => ({
        type: "usage" as const,
        audioDurationMs: event.usage.audio_duration_ms,
        limitStatus: event.usage_limit?.status ?? null,
        limitResetSeconds: event.usage_limit?.reset_seconds ?? null,
      }));
    case "session.closed":
      return Option.map(decodeSessionClosed(raw), (event) => ({
        type: "session.closed" as const,
        reason: event.reason ?? null,
      }));
    case "error":
      return Option.map(decodeErrorEvent(raw), (event) => ({
        type: "error" as const,
        code: event.error.code ?? "",
        message: event.error.message,
      }));
    default:
      return Option.none();
  }
};

export type RealtimeOutbound =
  | {
      readonly type: "delegation.context.append";
      readonly delegation_item_id: string;
      readonly channel: "speakable";
      readonly content: ReadonlyArray<{ readonly type: "input_text"; readonly text: string }>;
    }
  | {
      readonly type: "session.context.append";
      readonly channel: "speakable";
      readonly content: ReadonlyArray<{ readonly type: "input_text"; readonly text: string }>;
    }
  | { readonly type: "session.close" };

/** The session rejects a context append over 500 tokens; Codex sends 500 bytes at a time. */
export const CONTEXT_APPEND_MAX_BYTES = 500;

const encoder = new TextEncoder();

/** Splits text into pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
export const contextAppendChunks = (
  text: string,
  maxBytes = CONTEXT_APPEND_MAX_BYTES,
): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).length;
    if (currentBytes + bytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
};

const content = (text: string) => [{ type: "input_text" as const, text }];

/** The answer to one delegation, in as many appends as the size limit needs. */
export const delegationAnswerEvents = (
  delegationItemId: string,
  text: string,
): ReadonlyArray<RealtimeOutbound> =>
  contextAppendChunks(text).map((chunk) => ({
    type: "delegation.context.append",
    delegation_item_id: delegationItemId,
    channel: "speakable",
    content: content(chunk),
  }));

/** Something the voice should say without being asked. */
export const sessionUpdateEvents = (text: string): ReadonlyArray<RealtimeOutbound> =>
  contextAppendChunks(text).map((chunk) => ({
    type: "session.context.append",
    channel: "speakable",
    content: content(chunk),
  }));
