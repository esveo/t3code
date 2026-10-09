/**
 * Fork: user insights. Learning from messages typed before user insights
 * were turned on: which past messages an import takes, how they are batched,
 * how much an older batch counts, and what the whole import should cost.
 * Pure; the service reads the threads and runs the batches.
 */
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { type EvidenceRecord, isTypedUserMessage, toEvidence } from "./evidence.ts";
import { decay } from "./profileMerge.ts";
import { DISTILL_MAX_EXCERPTS } from "./prompts.ts";
import { redact } from "./redaction.ts";
import type { UsageRecord } from "./store.ts";
import { DAY_MS, fromIso } from "./time.ts";

export const IMPORT_MAX_AGE_DAYS = 30;
/** Records per batch: one model call shows at most this many excerpts. */
export const IMPORT_BATCH_SIZE = DISTILL_MAX_EXCERPTS;
export const IMPORT_MAX_BATCHES = 10;
export const IMPORT_MAX_MESSAGES = IMPORT_BATCH_SIZE * IMPORT_MAX_BATCHES;
export const REPLY_EXCERPT_MAX_CHARS = 200;
/** Cost assumed for one batch while the ledger has no successful learning call yet. */
export const IMPORT_FALLBACK_CALL_COST_USD = 0.03;

export interface PastThread {
  readonly projectId: string | null;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

const millis = (message: OrchestrationV2ConversationMessage) =>
  DateTime.toEpochMillis(message.createdAt);

/**
 * The redacted end of an agent reply: what the user answered is usually its
 * closing summary or question, not its start.
 */
export function replyExcerpt(text: string): string | undefined {
  const redacted = redact(text.trim());
  if (redacted.length === 0) return undefined;
  return redacted.length <= REPLY_EXCERPT_MAX_CHARS
    ? redacted
    : `…${redacted.slice(-(REPLY_EXCERPT_MAX_CHARS - 1)).trimStart()}`;
}

/**
 * The past messages an import learns from: typed by the user, from the last
 * 30 days, not yet in the evidence, the newest 300 at most. Each record keeps
 * its original time and, when the message answered an agent reply, the end
 * of that reply. Returned oldest first, the order the batches run in.
 */
export function selectPastMessages(
  threads: ReadonlyArray<PastThread>,
  input: { readonly now: number; readonly knownIds: ReadonlySet<string> },
): ReadonlyArray<EvidenceRecord> {
  const cutoff = input.now - IMPORT_MAX_AGE_DAYS * DAY_MS;
  const records: Array<EvidenceRecord> = [];
  for (const thread of threads) {
    let previous: OrchestrationV2ConversationMessage | null = null;
    for (const message of [...thread.messages].toSorted((a, b) => millis(a) - millis(b))) {
      if (message.role === "system" || message.streaming) continue;
      const before = previous;
      previous = message;
      if (!isTypedUserMessage(message)) continue;
      const at = millis(message);
      if (at < cutoff || at > input.now || input.knownIds.has(message.id)) continue;
      const record = toEvidence({ message, projectId: thread.projectId, now: at });
      const reply = before?.role === "assistant" ? replyExcerpt(before.text) : undefined;
      records.push(reply === undefined ? record : { ...record, reply });
    }
  }
  return records
    .toSorted((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, IMPORT_MAX_MESSAGES)
    .toReversed();
}

export const batchCount = (messages: number) => Math.ceil(messages / IMPORT_BATCH_SIZE);

/**
 * How much one batch counts: the 30-day half-life decay over the age of its
 * median message, so a batch from a month ago moves the profile half as far.
 */
export function batchWeight(batch: ReadonlyArray<{ readonly ts: string }>, now: number): number {
  if (batch.length === 0) return 1;
  const times = batch.map((record) => fromIso(record.ts)).toSorted((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median =
    times.length % 2 === 1
      ? (times[middle] ?? now)
      : ((times[middle - 1] ?? now) + (times[middle] ?? now)) / 2;
  return decay(1, now - median);
}

/** Batches times the average cost of the successful learning calls in the ledger. */
export function estimateImportCost(usage: ReadonlyArray<UsageRecord>, batches: number): number {
  const learning = usage.filter(
    (record) => record.ok && (record.purpose === "distill" || record.purpose === "import"),
  );
  const average =
    learning.length === 0
      ? IMPORT_FALLBACK_CALL_COST_USD
      : learning.reduce((sum, record) => sum + record.costUsd, 0) / learning.length;
  return batches * average;
}
