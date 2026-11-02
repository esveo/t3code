/**
 * Fork: when a realtime session talked to which thread, for the "Voice call
 * started/ended" lines in its chat. A call is not thread state, so this stays out
 * of the orchestration events. See docs/internals/voice-call.md.
 */
import { type ThreadId, VoiceCallThreadSpan } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

const StoredSpans = Schema.Array(
  Schema.Struct({ ...VoiceCallThreadSpan.fields, threadId: Schema.String }),
);
type StoredSpans = typeof StoredSpans.Type;
const StoredSpansJson = Schema.fromJsonString(StoredSpans);
const decodeStoredSpans = Schema.decodeUnknownOption(StoredSpansJson);
const encodeStoredSpans = Schema.encodeSync(StoredSpansJson);

// ponytail: a crash leaves no end time, so the restart stands in; a long outage overstates the call.
export const closeAbandonedSpans = (spans: StoredSpans, nowMs: number): StoredSpans =>
  spans.map((span) => (span.endedAt === null ? { ...span, endedAt: nowMs } : span));

export const makeVoiceCallThreadSpans = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "voice-call-thread-spans.json");

  const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
  const stored = Option.flatMap(contents, decodeStoredSpans);
  if (Option.isSome(contents) && Option.isNone(stored)) {
    yield* Effect.logWarning("voice call: unreadable thread spans file, starting empty");
  }
  let spans = closeAbandonedSpans(
    Option.getOrElse(stored, (): StoredSpans => []),
    yield* Clock.currentTimeMillis,
  );

  const save = Effect.suspend(() =>
    writeFileStringAtomically({ filePath, contents: encodeStoredSpans(spans) }),
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.catch((error) => Effect.logWarning("voice call: thread spans not saved", error.message)),
  );

  /** The file is written at the start too, so a crash mid-call still leaves its line. */
  const opened = Effect.fn("VoiceCallThreadSpans.opened")(function* (threadId: ThreadId) {
    const now = yield* Clock.currentTimeMillis;
    spans = [...spans, { threadId, startedAt: now, endedAt: null }];
    yield* save;
  }, Effect.uninterruptible);

  const closed = Effect.gen(function* () {
    if (spans.every((span) => span.endedAt !== null)) return;
    spans = closeAbandonedSpans(spans, yield* Clock.currentTimeMillis);
    yield* save;
  }).pipe(Effect.uninterruptible);

  const forThread = (threadId: ThreadId) =>
    Effect.sync(() =>
      spans.flatMap((span) =>
        span.threadId === threadId ? [{ startedAt: span.startedAt, endedAt: span.endedAt }] : [],
      ),
    );

  return { opened, closed, forThread };
});
