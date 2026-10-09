/**
 * Fork: user insights. Which domain events count as something the user typed,
 * and the record each of those messages leaves in `evidence.jsonl`. Pure; no
 * model is involved here.
 */
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isMostlyPasted, redact } from "./redaction.ts";
import { toIso } from "./time.ts";

export const EXCERPT_MAX_CHARS = 280;

export const EvidenceLanguage = Schema.Literals(["de", "en", "other"]);
export type EvidenceLanguage = typeof EvidenceLanguage.Type;

export const EvidenceRecord = Schema.Struct({
  ts: Schema.String,
  threadId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  messageId: Schema.String,
  chars: Schema.Number,
  words: Schema.Number,
  lang: EvidenceLanguage,
  hasCode: Schema.Boolean,
  hasPath: Schema.Boolean,
  endsWithQuestion: Schema.Boolean,
  /** The redacted start of the message; absent for mostly pasted content. */
  excerpt: Schema.optionalKey(Schema.String),
  /** Imported messages only: the redacted end of the agent reply the message answered. */
  reply: Schema.optionalKey(Schema.String),
});
export type EvidenceRecord = typeof EvidenceRecord.Type;

/** A message the user typed in a web or mobile client, done streaming. */
export type ObservableUserMessageEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "message.updated" }
>;

/**
 * Whether the event is a finished message the user typed themselves. Agent,
 * system, MCP, provider and server messages are left out, as are scheduled
 * prompts, messages one thread sends another, and slash commands.
 */
export function isObservableUserMessage(
  event: OrchestrationV2DomainEvent,
): event is ObservableUserMessageEvent {
  return event.type === "message.updated" && isTypedUserMessage(event.payload);
}

/** The same test on a stored message, for importing past ones. */
export function isTypedUserMessage(message: OrchestrationV2ConversationMessage): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined &&
    message.streaming === false &&
    message.text.trim().length > 0 &&
    !message.text.trimStart().startsWith("/")
  );
}

const GERMAN_WORDS = new Set(
  "und der die das ist nicht ich du wir ein eine mit auf für bitte noch auch dass wie was wenn dann aber oder kannst mach mal schon jetzt hier sind hast".split(
    " ",
  ),
);
const ENGLISH_WORDS = new Set(
  "the and is not you we a an with on for please also that how what if then but or can make just now here are have this it".split(
    " ",
  ),
);

/** A rough guess between German and English from common words and umlauts. */
export function guessLanguage(text: string): EvidenceLanguage {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  let german = /[äöüß]/i.test(text) ? 2 : 0;
  let english = 0;
  for (const word of words) {
    if (GERMAN_WORDS.has(word)) german += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }
  if (german === 0 && english === 0) return "other";
  return german >= english ? "de" : "en";
}

/** Message features that need no model. */
export function messageFeatures(text: string) {
  const trimmed = text.trim();
  return {
    chars: trimmed.length,
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
    lang: guessLanguage(trimmed),
    hasCode: /```|`[^`\n]+`/.test(trimmed),
    hasPath: /(?:^|[\s(`'"])(?:~|\.{1,2})?\/?[\w.-]+\/[\w./-]+/.test(trimmed),
    endsWithQuestion: /\?\s*$/.test(trimmed),
  };
}

/** The evidence record of one observed message. */
export function toEvidence(input: {
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "threadId" | "text">;
  readonly projectId: string | null;
  readonly now: number;
}): EvidenceRecord {
  const text = input.message.text;
  const features = messageFeatures(text);
  const record: EvidenceRecord = {
    ts: toIso(input.now),
    threadId: input.message.threadId,
    projectId: input.projectId,
    messageId: input.message.id,
    ...features,
  };
  if (isMostlyPasted(text)) return record;
  return { ...record, excerpt: redact(text.trim()).slice(0, EXCERPT_MAX_CHARS) };
}

/**
 * Remembers the last `capacity` ids, since `message.updated` can repeat for
 * one message. Returns true the first time an id is seen.
 */
export function makeSeenIds(capacity = 1000) {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > capacity) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}
